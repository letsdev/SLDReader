import { Style, Icon } from 'ol/style';
import { toContext } from 'ol/render';
import { Point, LineString } from 'ol/geom';
import {
  DEFAULT_MARK_SIZE,
  DEFAULT_EXTERNALGRAPHIC_SIZE,
  PLACEMENT_DEFAULT,
  PLACEMENT_FIRSTPOINT,
  PLACEMENT_LASTPOINT,
} from '../constants';
import evaluate from '../olEvaluator';
import getPointStyle from './pointStyle';
import { calculateGraphicSpacing, getInitialGapSize } from './styleUtils';
import {
  splitLineString,
  getGapCloserPoints,
  getIsRightTurn,
  getMirroredCoords,
  angleInRadiansAtB,
  calculatePointsDistance,
} from './geometryCalcs';

// A flag to prevent multiple renderer patches.
let rendererPatched = false;

// Global counter to track render sessions (to avoid deferred renderings being rendered after zoom, resulting in duplications and incorrect placing)
let currentRenderSessionByFeatureOlUid = new Map();

/**
 * Object containing maps to cache clipped image data as base64 strings.
 * Separate maps are used for different types of turns/segments.
 * @private
 */
const clipInfoHashToBase64 = {
  rightTurn: new Map(),
  leftTurn: new Map(),
  straight: new Map(),
};
const imageSourceHashToIsFullImg = new Map();
const USE_CACHING = true;

const TURN_DIRECTION_CONFIG = {
  right: {
    clipCacheKey: 'rightTurn',
    firstGapFlag: 'isFirstOfRightTurn',
    secondGapFlag: 'isSecondOfRightTurn',
    nextSegmentFlag: 'isFirstAfterRightTurn',
    getEdgeY: () => 0,
    getOppositeY: canvasHeight => canvasHeight,
    angledYDirection: 1,
  },
  left: {
    clipCacheKey: 'leftTurn',
    firstGapFlag: 'isFirstOfLeftTurn',
    secondGapFlag: 'isSecondOfLeftTurn',
    nextSegmentFlag: 'isFirstAfterLeftTurn',
    getEdgeY: canvasHeight => canvasHeight,
    getOppositeY: () => 0,
    angledYDirection: -1,
  },
};

// Used to quickly check if canvasses are empty
let emptyCanvasSrc = null;

function patchRenderer(renderer) {
  // if (rendererPatched) {
  //   return;
  // }

  // Add setImageStyle2 function that does the same as setImageStyle, except that it sets rotation
  // to a given value instead of taking it from imageStyle.getRotation().
  // This fixes a problem with re-use of the (cached) image style instance when drawing
  // many points inside a single line feature that are aligned according to line segment direction.
  const rendererProto = Object.getPrototypeOf(renderer);
  // eslint-disable-next-line
  rendererProto.setImageStyle2 = function (imageStyle, rotation) {
    // First call the original setImageStyle method.
    rendererProto.setImageStyle.call(this, imageStyle);

    // Then set rotation according to the given parameter.
    // This overrides the following line in setImageStyle:
    // this.imageRotation_ = imageStyle.getRotation()
    if (this.image_) {
      this.imageRotation_ = rotation;
    }
  };

  rendererPatched = true;
}

/**
 * Directly render graphic stroke marks for a line onto canvas.
 * @private
 * @param {ol/render/canvas/Immediate} render Instance of CanvasImmediateRenderer used to paint stroke marks directly to the canvas.
 * @param {Array<Array<number>>} pixelCoords A line as array of [x,y] point coordinate arrays in pixel space.
 * @param {number} graphicSpacing The center-to-center distance in pixels for stroke marks distributed along the line.
 * @param {ol/style/Style} pointStyle OpenLayers style instance used for rendering stroke marks.
 * @param {number} pixelRatio Ratio of device pixels to css pixels.
 * @returns {void}
 */
async function renderStrokeMarks(
  renderContext,
  pixelCoords,
  graphicSpacing,
  pointStyle,
  pixelRatio,
  options,
  geometryType,
  feature,
) {
  if (!pixelCoords) {
    return;
  }

  // This will be used when rendering images that have just loaded, to make sure the render is still current, will be aborted otherwise.
  currentRenderSessionByFeatureOlUid.set(
    feature.ol_uid,
    currentRenderSessionByFeatureOlUid.has(feature.ol_uid)
      ? currentRenderSessionByFeatureOlUid.get(feature.ol_uid) + 1
      : 1,
  );
  const thisRenderSession = currentRenderSessionByFeatureOlUid.get(feature.ol_uid);

  // We use the context as param and create the render object here, because we need to create deep copies later.
  const render = toContext(renderContext);

  // The first element of the first pixelCoords entry should be a number (x-coordinate of first point).
  // If it's an array instead, then we're dealing with a multiline or (multi)polygon.
  // In that case, recursively call renderStrokeMarks for each child coordinate array.
  if (Array.isArray(pixelCoords[0][0])) {
    pixelCoords.forEach(function (pixelCoordsChildArray) {
      renderStrokeMarks(
        renderContext,
        pixelCoordsChildArray,
        graphicSpacing,
        pointStyle,
        pixelRatio,
        options,
        geometryType,
        feature,
      );
    });
    return;
  }

  // Line should be a proper line with at least two coordinates.
  if (pixelCoords.length < 2) {
    return;
  }

  // Don't render anything when the pointStyle has no image.
  const ogImage = pointStyle.getImage();
  if (!ogImage) {
    return;
  }

  if (!ogImage.iconImage_) {
    return;
  }

  let ogImageWidth = null;
  let ogImageHeight = null;
  if (ogImage.getSize()) {
    ogImageWidth = ogImage.getSize()[0];
    ogImageHeight = ogImage.getSize()[1];
  }

  const gapSize = graphicSpacing * pixelRatio;
  const isFullImg = await getIsFullImg({
    image: ogImage,
    imageWidth: ogImageWidth,
    imageHeight: ogImageHeight,
    pixelRatio,
  });

  const splitPoints = splitLineString(
    new LineString(pixelCoords),
    gapSize,
    {
      invertY: true, // Pixel y-coordinates increase downwards in screen space.
      extent: render.extent_,
      placement: options.placement,
      initialGap: options.initialGap,
      graphicWidth: ogImageWidth,
    },
  );

  // These placement options don't work with / require our complex clipping logic below. Simply render those as in previous versions.
  if ([PLACEMENT_FIRSTPOINT, PLACEMENT_LASTPOINT].includes(options.placement)) {
    splitPoints.forEach(point => {
      const splitPointAngle = ogImage.getRotation() + point[2];
      patchRenderer(render);
      render.setImageStyle2(ogImage, splitPointAngle);
      render.drawPoint(new Point([point[0] / pixelRatio, point[1] / pixelRatio]));
    });

    return;
  }

  const pointsDataToRender = [];
  let currentGeometryCoordIndex = null;
  for (let i = 0; i < splitPoints.length; i++) {
    const point = splitPoints[i];
    let customRender = render;
    let image = ogImage;
    let renderCoords = point.splitPointCoords;

    const isFirstOfGeometry = i === 0;
    const isFirstOfSegment = currentGeometryCoordIndex !== point.startingGeometryCoordIndex;
    if (isFirstOfSegment) {
      currentGeometryCoordIndex = point.startingGeometryCoordIndex;
    }
    const isRightTurn = !isFirstOfGeometry
      && isFirstOfSegment
      && getIsRightTurn(
        pixelCoords[currentGeometryCoordIndex - 1],
        pixelCoords[currentGeometryCoordIndex],
        pixelCoords[currentGeometryCoordIndex + 1],
      );
    const isLeftTurn = !isFirstOfGeometry
      && isFirstOfSegment
      && !isRightTurn;
    const isRegularButShortened = !isRightTurn
      && !isLeftTurn
      && point.segmentLength !== null && point.segmentLength !== undefined;

    point.isRightTurn = isRightTurn;
    point.isLeftTurn = isLeftTurn;
    point.isFirstOfSegment = isFirstOfSegment;
    point.isFirstOfGeometry = isFirstOfGeometry;
    point.isRegularButShortened = isRegularButShortened;

    const newPointsDataToRender = await getNewPointsDataToRender({
      i,
      point,
      splitPoints,
      pixelCoords,
      geometryType,
      currentGeometryCoordIndex,
      pointsDataToRender,
      ogImage,
      ogImageWidth,
      ogImageHeight,
      pixelRatio,
      gapSize,
      image,
      renderCoords,
      customRender,
      renderContext,
      isRightTurn,
      isLeftTurn,
      isFirstOfGeometry,
      isFirstOfSegment,
      isRegularButShortened,
      isFullImg,
    });

    newPointsDataToRender.forEach(it => {
      it.fromSplitPoint = point;
    });

    pointsDataToRender.push(...newPointsDataToRender);
  }

  pointsDataToRender
    .filter(it => !it.ignore)
    .forEach(pointDataToRender => {
      renderPoint({
        image: pointDataToRender.image,
        angle: pointDataToRender.angle,
        coords: pointDataToRender.coords,
        renderToUse: pointDataToRender.rendererToUse,
        pixelRatio: pixelRatio,
        renderSession: thisRenderSession,
        feature,
      });
    });
}

/**
 * Dispatch turn handling to the full-image or half-image path.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function getNewPointsDataToRender(options) {
  if (options.isFullImg) {
    return getNewPointsDataToRenderForFullImg(options);
  }

  return getNewPointsDataToRenderForHalfImg(options);
}

/**
 * Build render data for full images, where both turn directions use the shared
 * turn pipeline.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function getNewPointsDataToRenderForFullImg(options) {
  const {
    isRightTurn,
    isLeftTurn,
  } = options;
  let newPointsDataToRender;

  if (isRightTurn) {
    newPointsDataToRender = await handleCurrentTurn(options, handleRightTurn);
  } else if (isLeftTurn) {
    newPointsDataToRender = await handleCurrentTurn(options, handleLeftTurn);
  } else {
    newPointsDataToRender = await getRegularOrUnchangedPointsData(options);
  }

  await appendPolygonClosingGapFillRenderData(options, newPointsDataToRender, {
    supportsClosingLeftTurn: true,
  });

  return newPointsDataToRender;
}

/**
 * Build render data for half images, preserving the dedicated left-turn path.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function getNewPointsDataToRenderForHalfImg(options) {
  const {
    i,
    point,
    splitPoints,
    isRightTurn,
    isLeftTurn,
    isFirstOfSegment,
  } = options;
  const isFirstAfterLeftTurn = !isLeftTurn
    && !isRightTurn
    && !isFirstOfSegment
    && i > 1
    && splitPoints[i - 1].isLeftTurn;

  point.isFirstAfterLeftTurn = isFirstAfterLeftTurn;

  let newPointsDataToRender;
  if (isRightTurn) {
    newPointsDataToRender = await handleCurrentTurn(options, handleRightTurn);
  } else if (isLeftTurn) {
    newPointsDataToRender = await handleHalfImageLeftTurn(options);
  } else if (isFirstAfterLeftTurn) {
    newPointsDataToRender = await handleHalfImageFirstAfterLeftTurn(options);
  } else {
    newPointsDataToRender = await getRegularOrUnchangedPointsData(options);
  }

  await appendPolygonClosingGapFillRenderData(options, newPointsDataToRender, {
    supportsClosingLeftTurn: false,
  });

  return newPointsDataToRender;
}

/**
 * Invoke a turn handler with the normalized option structure used by right and
 * left turns.
 * @param {Object} options Per-split-point rendering context.
 * @param {Function} turnHandler Turn-specific handler to execute.
 * @returns {Promise<Array<Object>>} Render data for the turn.
 */
async function handleCurrentTurn(options, turnHandler) {
  return turnHandler(getTurnHandlerOptions(options, {
    splitPoint: options.point,
    onlyDoGap: false,
    involvedGeometryCoords: getInvolvedGeometryCoords(
      options.pixelCoords,
      options.currentGeometryCoordIndex,
    ),
  }));
}

/**
 * Choose between shortened-segment rendering and the unchanged render point.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function getRegularOrUnchangedPointsData(options) {
  if (options.isRegularButShortened) {
    return handleRegularButShortened(getRegularButShortenedOptions(options));
  }

  return [createUnchangedPointData(options)];
}

/**
 * Build the shared option payload consumed by turn handlers.
 * @param {Object} options Per-split-point rendering context.
 * @param {Object} overrides Turn-specific overrides.
 * @returns {Object} Normalized turn-handler options.
 */
function getTurnHandlerOptions(options, overrides = {}) {
  return {
    currentGeometryCoordIndex: options.currentGeometryCoordIndex,
    pointsDataToRender: options.pointsDataToRender,
    pImage: options.ogImage,
    pImageWidth: options.ogImageWidth,
    pImageHeight: options.ogImageHeight,
    pRenderContext: options.renderContext,
    ogImageWidth: options.ogImageWidth,
    ogImageHeight: options.ogImageHeight,
    gapSize: options.gapSize,
    ...overrides,
  };
}

/**
 * Build the option payload for shortened straight segments.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Object} Options for shortened straight rendering.
 */
function getRegularButShortenedOptions(options) {
  return {
    point: options.point,
    gapSize: options.gapSize,
    ogImageWidth: options.ogImageWidth,
    ogImageHeight: options.ogImageHeight,
    ogImage: options.ogImage,
    pixelRatio: options.pixelRatio,
    image: options.image,
    renderCoords: options.renderCoords,
    customRender: options.customRender,
    currentGeometryCoordIndex: options.currentGeometryCoordIndex,
  };
}

/**
 * Return the geometry coordinates adjacent to the current turn vertex.
 * @param {Array<Array<number>>} pixelCoords Geometry coordinates in pixel space.
 * @param {number} geometryCoordIndex Index of the current vertex.
 * @returns {Object} Incoming coord, vertex coord, and outgoing coord.
 */
function getInvolvedGeometryCoords(pixelCoords, geometryCoordIndex) {
  return {
    coordOnFirstLine: pixelCoords[geometryCoordIndex - 1],
    intersectCoord: pixelCoords[geometryCoordIndex],
    coordOnSecondLine: pixelCoords[geometryCoordIndex + 1],
  };
}

/**
 * Create render data for a split point that does not need special clipping.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Object} Render data for the unchanged point.
 */
function createUnchangedPointData(options) {
  return {
    image: options.image,
    angle: options.point.angle,
    coords: options.renderCoords,
    rendererToUse: options.customRender,
    geometryCoordIndex: options.currentGeometryCoordIndex,
  };
}

/**
 * Detect the synthetic closing turn of a polygon ring and collect the geometry
 * data needed to render its gap filler.
 * @param {Object} options Per-split-point rendering context.
 * @returns {?Object} Closing-turn context or `null` when not applicable.
 */
function getPolygonClosingContext(options) {
  const {
    i,
    point,
    splitPoints,
    pixelCoords,
    geometryType,
  } = options;
  const isPolygon = geometryType.includes('olygon');
  if (!isPolygon || i !== splitPoints.length - 1) {
    return null;
  }

  const hasAdditionalPixelCoord = point.startingGeometryCoordIndex === pixelCoords.length - 2;
  if (!hasAdditionalPixelCoord) {
    return null;
  }

  const nextPixelIsClosingPoint = point.startingGeometryCoordIndex !== 0
    && pixelCoords[point.startingGeometryCoordIndex + 1][0] === pixelCoords[0][0]
    && pixelCoords[point.startingGeometryCoordIndex + 1][1] === pixelCoords[0][1];
  if (!nextPixelIsClosingPoint) {
    return null;
  }

  const lastSplitPoint = point;
  const firstSplitPoint = splitPoints[0];
  return {
    firstSplitPoint,
    endOfPolygonIsRightTurn: getIsRightTurn(
      pixelCoords[lastSplitPoint.startingGeometryCoordIndex],
      pixelCoords[lastSplitPoint.startingGeometryCoordIndex + 1],
      pixelCoords[1],
    ),
    involvedGeometryCoords: {
      coordOnFirstLine: pixelCoords[lastSplitPoint.startingGeometryCoordIndex],
      intersectCoord: pixelCoords[0],
      coordOnSecondLine: pixelCoords[1],
    },
  };
}

/**
 * Append polygon-closing gap-fill render data when the current split point is
 * the last one on a polygon ring.
 * @param {Object} options Per-split-point rendering context.
 * @param {Array<Object>} newPointsDataToRender Render data collected so far.
 * @param {Object} policy Flags controlling which closing turns are supported.
 * @returns {Promise<void>}
 */
async function appendPolygonClosingGapFillRenderData(options, newPointsDataToRender, policy) {
  const polygonClosingGapFillRenderData = await getPolygonClosingGapFillRenderData(options, policy);
  if (polygonClosingGapFillRenderData) {
    newPointsDataToRender.push(...polygonClosingGapFillRenderData);
  }
}

/**
 * Create the gap-filling render data for the implicit closing turn of a polygon
 * ring when supported by the active rendering policy.
 * @param {Object} options Per-split-point rendering context.
 * @param {Object} policy Flags controlling which closing turns are supported.
 * @returns {Promise<?Array<Object>>} Gap-fill render data or `null`.
 */
async function getPolygonClosingGapFillRenderData(options, policy) {
  const polygonClosingContext = getPolygonClosingContext(options);
  if (!polygonClosingContext) {
    return null;
  }

  if (!polygonClosingContext.endOfPolygonIsRightTurn && !policy.supportsClosingLeftTurn) {
    return null;
  }

  const turnHandler = polygonClosingContext.endOfPolygonIsRightTurn
    ? handleRightTurn
    : handleLeftTurn;
  return turnHandler(getTurnHandlerOptions(options, {
    currentGeometryCoordIndex: polygonClosingContext.firstSplitPoint.startingGeometryCoordIndex,
    splitPoint: polygonClosingContext.firstSplitPoint,
    onlyDoGap: true,
    involvedGeometryCoords: polygonClosingContext.involvedGeometryCoords,
  }));
}

/**
 * Detect whether an icon contains visible content in the lower half and should
 * therefore use the full-image rendering path.
 * @param {Object} options Image and sizing information.
 * @returns {Promise<boolean>} `true` when the image is treated as full.
 */
async function getIsFullImg(options) {
  const {
    image,
    imageWidth,
    imageHeight,
    pixelRatio,
  } = options;
  if (!imageWidth || !imageHeight) {
    return false;
  }

  const imageSrc = image.iconImage_?.src_ || image.getSrc?.() || '';
  const cacheKey = `${imageSrc}|${imageWidth}x${imageHeight}`;
  if (imageSourceHashToIsFullImg.has(cacheKey)) {
    return imageSourceHashToIsFullImg.get(cacheKey);
  }

  const imageElement = await getLoadedImageElement(image, pixelRatio);
  if (!imageElement) {
    imageSourceHashToIsFullImg.set(cacheKey, false);
    return false;
  }

  let isFullImg = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageElement, 0, 0, imageWidth, imageHeight);

    const bottomHalfStartY = Math.min(imageHeight, Math.floor(imageHeight / 2) + 1);
    const bottomHalfHeight = imageHeight - bottomHalfStartY;
    if (bottomHalfHeight > 0) {
      const pixelData = ctx.getImageData(0, bottomHalfStartY, imageWidth, bottomHalfHeight).data;
      for (let i = 3; i < pixelData.length; i += 4) {
        if (pixelData[i] > 16) {
          isFullImg = true;
          break;
        }
      }
    }
  } catch (_) {
    isFullImg = false;
  }

  imageSourceHashToIsFullImg.set(cacheKey, isFullImg);
  return isFullImg;
}

/**
 * Resolve the concrete image element used by an OpenLayers icon, waiting for it
 * to load when necessary.
 * @param {Icon} image OpenLayers icon style.
 * @param {number} pixelRatio Current device pixel ratio.
 * @returns {Promise<?(HTMLImageElement|HTMLCanvasElement)>} Loaded image element or `null`.
 */
function getLoadedImageElement(image, pixelRatio) {
  const imageElement = image.getImage(pixelRatio) || image.iconImage_?.image_;
  return new Promise(resolve => {
    if (!imageElement) {
      resolve(null);
      return;
    }

    if (typeof HTMLCanvasElement !== 'undefined' && imageElement instanceof HTMLCanvasElement) {
      resolve(imageElement);
      return;
    }

    if (imageElement.complete) {
      resolve(imageElement);
      return;
    }

    imageElement.onload = () => resolve(imageElement);
    imageElement.onerror = () => resolve(null);
  });
}

/**
 * Look up the direction-specific clipping and flag configuration for a turn.
 * @param {'right'|'left'} turnDirection Requested turn direction.
 * @returns {Object} Direction-specific config object.
 */
function getTurnDirectionConfig(turnDirection) {
  const turnDirectionConfig = TURN_DIRECTION_CONFIG[turnDirection];

  if (!turnDirectionConfig) {
    throw new Error(`Unsupported turn direction: ${turnDirection}`);
  }

  return turnDirectionConfig;
}

/**
 * Thin wrapper that routes right turns into the shared turn implementation.
 * @param {Object} options Turn-rendering options.
 * @returns {Promise<Array<Object>>} Render data for the turn.
 */
async function handleRightTurn(options) {
  return handleTurn({
    ...options,
    turnDirection: 'right',
  });
}

/**
 * Render the shared turn pipeline used by right turns and full-image left turns.
 * @param {Object} options Turn-rendering options.
 * @returns {Promise<Array<Object>>} Render data for the turn.
 */
async function handleTurn(options) {
  const currentGeometryCoordIndex = options.currentGeometryCoordIndex;
  const pImage = options.pImage;
  const pImageWidth = options.pImageWidth;
  const pImageHeight = options.pImageHeight;
  const pRenderContext = options.pRenderContext;
  const ogImageWidth = options.ogImageWidth;
  const ogImageHeight = options.ogImageHeight;
  const splitPoint = options.splitPoint;
  const gapSize = options.gapSize;
  const onlyDoGap = options.onlyDoGap;
  const involvedGeometryCoords = options.involvedGeometryCoords;
  const turnDirection = options.turnDirection;
  const turnDirectionConfig = getTurnDirectionConfig(turnDirection);

  const gapCloserPointData = getGapCloserPoints({
    coordOnFirstLine: involvedGeometryCoords.coordOnFirstLine,
    intersectCoord: involvedGeometryCoords.intersectCoord,
    coordOnSecondLine: involvedGeometryCoords.coordOnSecondLine,
    mirrorOffset: ogImageHeight / 2, /* half because we anchor at 0.5 */
  });
  const gapCloserPoints = [gapCloserPointData.forwardPoint, gapCloserPointData.backwardPoint];

  // 1 - Create gap-closing render points
  const gapCloserRenderPoints = [];
  for (let i = 0; i < 2; i++) {
    const gapCloserPoint = gapCloserPoints[i];

    // This happens when the angle is so narrow, that the length of the corner is larger than the image width.
    // We cannot sensibly cut here, we'd have to add another point. Instead, we cut the second half in the beginning to match the first.
    if (!gapCloserPoint.isFirst && gapCloserPoints[0].cutLength > pImageWidth) {
      gapCloserPoint.cutInFront = gapCloserPoints[0].cutLength - pImageWidth;
    }

    const imageAnchor = gapCloserPoint.isFirst
      ? [0, 0.5]
      : [1, 0.5];
    const gapCloserImage = await clipToIcon({
      imageStyle: pImage,
      clipper: getClippedImageForTurn,
      clipInfo: gapCloserPoint,
      canvasSize: [ogImageWidth, ogImageHeight],
      clipperOptions: {
        turnDirection,
      },
      anchor: imageAnchor,
    });

    const gapCloserRenderer = toContext(pRenderContext);

    gapCloserRenderPoints.push({
      image: gapCloserImage,
      angle: gapCloserPoint.angle,
      coords: gapCloserPoint.intersectCoords,
      rendererToUse: gapCloserRenderer,
      [turnDirectionConfig.firstGapFlag]: gapCloserPoint.isFirst,
      [turnDirectionConfig.secondGapFlag]: !gapCloserPoint.isFirst,
      isClipped: true,
    });
  }
  // \1 - finished

  if (onlyDoGap) {
    return [
      ...gapCloserRenderPoints,
    ];
  }

  // 2 - Now add the actual next segment, past the gap closers
  const nextSegmentCutRatio = (splitPoint.segmentLength || gapSize) / gapSize;
  const nextSegmentCutLength = nextSegmentCutRatio * ogImageWidth;
  const nextSegmentClipInfo = {
    cutLength: nextSegmentCutLength,
  };
  const nextSegmentImageAnchor = [0, 0.5];
  const nextSegmentImage = await clipToIcon({
    imageStyle: pImage,
    clipper: getClippedImageNoAngle,
    clipInfo: nextSegmentClipInfo,
    canvasSize: [ogImageWidth, ogImageHeight],
    anchor: nextSegmentImageAnchor,
  });

  const nextSegmentRenderer = toContext(pRenderContext);

  const nextSegmentRenderPoint = {
    // ignore: true,
    image: nextSegmentImage,
    angle: gapCloserPointData.backwardPoint.angle,
    coords: gapCloserPointData.backwardPoint.intersectCoords,
    rendererToUse: nextSegmentRenderer,
    geometryCoordIndex: currentGeometryCoordIndex,
    [turnDirectionConfig.nextSegmentFlag]: true,
    isClipped: nextSegmentCutRatio < 1,
    clippedAtLength: nextSegmentCutLength,
  };
  // \2 - finished

  const result = [
    ...gapCloserRenderPoints,
    nextSegmentRenderPoint,
  ];
  return result;
}

/**
 * Clip and render a straight segment whose available length is shorter than one
 * full symbol width.
 * @param {Object} options Shortened-segment rendering options.
 * @returns {Promise<Array<Object>>} Render data for the shortened point.
 */
async function handleRegularButShortened(options) {
  const point = options.point;
  const gapSize = options.gapSize;
  const ogImageWidth = options.ogImageWidth;
  const ogImage = options.ogImage;
  let image = options.image;
  const renderCoords = options.renderCoords;
  const customRender = options.customRender;
  const currentGeometryCoordIndex = options.currentGeometryCoordIndex;

  const cutRatio = point.segmentLength / gapSize;
  const cutLength = cutRatio * ogImageWidth;
  const imageAnchor = point.isFirstOfGeometry
    ? [0.5, 0.5]
    : [0, 0.5];
  image = await clipToIcon({
    imageStyle: ogImage,
    clipper: getClippedImageNoAngle,
    clipInfo: {
      cutLength: point.isFirstOfGeometry
        ? ogImageWidth - cutLength
        : cutLength,
      cutInFront: false,
      cutOnBothEnds: point.isFirstOfGeometry,
    },
    canvasSize: [ogImageWidth, options.ogImageHeight],
    anchor: imageAnchor,
  });

  const result = [
    {
      // ignore: true,
      image: image,
      angle: point.angle,
      coords: renderCoords,
      rendererToUse: customRender,
      geometryCoordIndex: currentGeometryCoordIndex,
    },
  ];
  return result;
}

/**
 * Render the legacy half-image left-turn path by clipping the current point and
 * retroactively adjusting the incoming segment.
 * @param {Object} options Turn-rendering options.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function handleHalfImageLeftTurn(options) {
  const {
    pixelCoords,
    point,
    currentGeometryCoordIndex,
    ogImageWidth,
    ogImageHeight,
    ogImage,
    renderContext,
    pointsDataToRender,
    gapSize,
  } = options;

  const mirroredCoords = getMirroredCoords(
    pixelCoords[currentGeometryCoordIndex - 1],
    pixelCoords[currentGeometryCoordIndex],
    pixelCoords[currentGeometryCoordIndex + 1],
    true,
    ogImageHeight / 2,
  );
  const cutAngle = angleInRadiansAtB(
    mirroredCoords.intersect,
    pixelCoords[currentGeometryCoordIndex],
    pixelCoords[currentGeometryCoordIndex + 1],
  );
  const cutLength = point.segmentLength || gapSize;
  const clipInfo = {
    isFirst: false,
    isRightTurn: false,
    cutRatio: cutLength / gapSize,
    cutHeight: 0.5 * ogImageHeight,
    cutAngle,
  };

  const image = await clipToIcon({
    imageStyle: ogImage,
    clipper: getClippedImageForLeftTurn,
    clipInfo,
    canvasSize: [ogImageWidth, ogImageHeight],
    anchor: [0.5, 0.5],
  });

  const firstHalfOfLeftTurnRenderData = pointsDataToRender[pointsDataToRender.length - 1];
  if (firstHalfOfLeftTurnRenderData) {
    const firstHalfOfLeftTurnCutRatio = firstHalfOfLeftTurnRenderData.clippedAtLength / ogImageWidth;
    const adjustingClipInfo = {
      isFirst: true,
      isRightTurn: false,
      cutRatio: firstHalfOfLeftTurnCutRatio,
      cutHeight: 0.5 * ogImageHeight,
      cutAngle,
    };
    firstHalfOfLeftTurnRenderData.image = await clipToIcon({
      imageStyle: firstHalfOfLeftTurnRenderData.image,
      clipper: getClippedImageForLeftTurn,
      clipInfo: adjustingClipInfo,
      canvasSize: [ogImageWidth, ogImageHeight],
      anchor: firstHalfOfLeftTurnRenderData.fromSplitPoint.isFirstOfGeometry
        ? [0.5, 0.5]
        : firstHalfOfLeftTurnRenderData.image.anchor_,
    });

    const hasRenderDataBeforeTurnOnSameSegment = pointsDataToRender.length - 2 >= 0
      && pointsDataToRender[pointsDataToRender.length - 2].geometryCoordIndex === firstHalfOfLeftTurnRenderData.geometryCoordIndex;
    if (hasRenderDataBeforeTurnOnSameSegment) {
      const lastRenderDataBeforeTurn = pointsDataToRender[pointsDataToRender.length - 2];
      const incomingSpacing = calculatePointsDistance(
        lastRenderDataBeforeTurn.coords,
        firstHalfOfLeftTurnRenderData.coords,
      );
      const firstHalfOfLeftTurnVisibleLength = Number.isFinite(firstHalfOfLeftTurnRenderData.clippedAtLength)
        ? Math.min(firstHalfOfLeftTurnRenderData.clippedAtLength, ogImageWidth)
        : ogImageWidth;
      const uncoveredFrontRatio = 1 - (firstHalfOfLeftTurnVisibleLength / ogImageWidth);
      const incomingSpacingRatio = incomingSpacing / gapSize;
      const shouldClipPreviousIncomingPoint = incomingSpacingRatio + 1e-11 < uncoveredFrontRatio;

      if (shouldClipPreviousIncomingPoint) {
        const lastRenderDataBeforeTurnCutRatio = calculatePointsDistance(
          lastRenderDataBeforeTurn.coords,
          point.splitPointCoords,
        ) / gapSize;
        const lastRenderDataBeforeTurnCutLength = lastRenderDataBeforeTurnCutRatio * ogImageWidth;
        lastRenderDataBeforeTurn.image = await clipToIcon({
          imageStyle: lastRenderDataBeforeTurn.image,
          clipper: getClippedImageNoAngle,
          clipInfo: {
            cutLength: lastRenderDataBeforeTurnCutLength,
            cutInFront: false,
          },
          canvasSize: [ogImageWidth, ogImageHeight],
          anchor: lastRenderDataBeforeTurn.image.anchor_,
        });
      }
    }
  }

  return [
    {
      image,
      angle: point.angle,
      coords: point.splitPointCoords,
      rendererToUse: toContext(renderContext),
      geometryCoordIndex: currentGeometryCoordIndex,
    },
  ];
}

/**
 * Render the first regular symbol after a half-image left turn, preserving the
 * preexisting straight-segment clipping rules.
 * @param {Object} options Per-split-point rendering context.
 * @returns {Promise<Array<Object>>} Render data for the current split point.
 */
async function handleHalfImageFirstAfterLeftTurn(options) {
  const {
    i,
    point,
    splitPoints,
    gapSize,
    ogImageWidth,
    ogImageHeight,
    ogImage,
    image,
    renderCoords,
    customRender,
    currentGeometryCoordIndex,
  } = options;
  let clippedImage;

  if (point.segmentLength === null || point.segmentLength === undefined) {
    const distanceToPreviousSpPointInGapSize = calculatePointsDistance(
      point.splitPointCoords,
      splitPoints[i - 1].splitPointCoords,
    );
    const distanceToPreviousSpPointRatio = distanceToPreviousSpPointInGapSize / gapSize;
    const distanceToPreviousSpPoint = distanceToPreviousSpPointRatio * ogImageWidth;

    if (distanceToPreviousSpPoint + 1e-11 < ogImageWidth) {
      clippedImage = await clipToIcon({
        imageStyle: ogImage,
        clipper: getClippedImageNoAngle,
        clipInfo: {
          cutLength: distanceToPreviousSpPoint,
          cutInFront: true,
          cutOnBothEnds: false,
        },
        canvasSize: [ogImageWidth, ogImageHeight],
        anchor: [0.5, 0.5],
      });
    } else {
      clippedImage = await clipToIcon({
        imageStyle: ogImage,
        clipper: getClippedImageNoAngle,
        clipInfo: {},
        canvasSize: [ogImageWidth, ogImageHeight],
        anchor: [0.5, 0.5],
      });
    }
  } else {
    clippedImage = await clipToIcon({
      imageStyle: ogImage,
      clipper: getClippedImageNoAngle,
      clipInfo: {
        cutLength: point.segmentLength,
        cutInFront: false,
        cutOnBothEnds: true,
      },
      canvasSize: [ogImageWidth, ogImageHeight],
      anchor: [0.5, 0.5],
    });
  }

  return [
    {
      image: clippedImage || image,
      angle: point.angle,
      coords: renderCoords,
      rendererToUse: customRender,
      geometryCoordIndex: currentGeometryCoordIndex,
    },
  ];
}

/**
 * Thin wrapper that routes full-image left turns into the shared turn
 * implementation.
 * @param {Object} options Turn-rendering options.
 * @returns {Promise<Array<Object>>} Render data for the turn.
 */
async function handleLeftTurn(options) {
  return handleTurn({
    ...options,
    turnDirection: 'left',
  });
}

/**
 * Clip an icon into one half of a corner using the shared turn geometry for the
 * configured turn direction.
 * @param {Object} options Clip inputs and canvas dimensions.
 * @returns {Promise<string>} Data URL of the clipped image.
 */
function getClippedImageForTurn(options) {
  const img = options.img;
  const clipInfo = options.clipInfo;
  const canvasWidth = options.canvasWidth;
  const canvasHeight = options.canvasHeight;
  const turnDirection = options.turnDirection;
  const turnDirectionConfig = getTurnDirectionConfig(turnDirection);

  return new Promise((res, _) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    const cutLength = clipInfo.cutLength;
    const canvasDiagonal = Math.sqrt(
      (canvasWidth > cutLength
        ? canvas.width ** 2
        : cutLength ** 2) + canvas.height ** 2,
    ); // This is the max distance within the canvas

    const clipInfoHashCode = getHashCode({
      angle: clipInfo.angle,
      cutAngle: clipInfo.cutAngle,
      cutLength: clipInfo.cutLength,
      canvasDiagonal: clipInfo.canvasDiagonal,
      isFirst: clipInfo.isFirst,
      img: img.src,
    });
    const clipCache = clipInfoHashToBase64[turnDirectionConfig.clipCacheKey];
    if (USE_CACHING && clipCache.has(clipInfoHashCode)) {
      return res(clipCache.get(clipInfoHashCode).base64);
    }

    ctx.save();
    ctx.beginPath();
    const edgeY = turnDirectionConfig.getEdgeY(canvasHeight);
    const oppositeY = turnDirectionConfig.getOppositeY(canvasHeight);
    const angledYOffset = turnDirectionConfig.angledYDirection
      * Math.sin(clipInfo.cutAngle) * canvasDiagonal;

    if (clipInfo.isFirst) {
      ctx.moveTo(0, edgeY);
      ctx.lineTo(cutLength, edgeY);
      const angledX = cutLength + Math.cos(Math.PI - clipInfo.cutAngle) * canvasDiagonal;
      const angledY = edgeY + angledYOffset;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(0, oppositeY);
      ctx.closePath();
      ctx.clip();
    } else {
      ctx.moveTo(canvasWidth, edgeY);
      ctx.lineTo(canvasWidth - cutLength, edgeY);
      const angledX = canvasWidth - cutLength + Math.cos(clipInfo.cutAngle) * canvasDiagonal;
      const angledY = edgeY + angledYOffset;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(canvasWidth, oppositeY);
      ctx.closePath();
      ctx.clip();
    }

    if (img.complete) {
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      const result = canvas.toDataURL();
      if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
        // We don't cache empty canvasses
        clipCache.set(clipInfoHashCode, {
          base64: result,
          clipInfo: clipInfo,
        });
      }
      res(result);
    } else {
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        ctx.restore();

        const result = canvas.toDataURL();
        if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
          // We don't cache empty canvasses
          clipCache.set(clipInfoHashCode, {
            base64: result,
            clipInfo: clipInfo,
          });
        }
        res(result);
      };
    }
  });
}

/**
 * Clip an icon into one half of a half-image left turn using the legacy
 * left-turn polygon shape.
 * @param {Object} options Clip inputs and canvas dimensions.
 * @returns {Promise<string>} Data URL of the clipped image.
 */
function getClippedImageForLeftTurn(options) {
  const {
    img,
    clipInfo,
    canvasWidth,
    canvasHeight,
  } = options;

  return new Promise((res, _) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    const canvasDiagonal = Math.sqrt(canvas.width ** 2 + canvas.height ** 2);
    const cutLength = clipInfo.cutRatio
      ? clipInfo.cutRatio * canvas.width
      : undefined;

    const clipInfoHashCode = getHashCode({
      cutAngle: clipInfo.cutAngle,
      cutLength,
      canvasDiagonal,
      isFirst: clipInfo.isFirst,
      img: img.src,
    });
    if (USE_CACHING && clipInfoHashToBase64.leftTurn.has(clipInfoHashCode)) {
      return res(clipInfoHashToBase64.leftTurn.get(clipInfoHashCode).base64);
    }

    ctx.save();
    ctx.beginPath();

    if (clipInfo.isFirst) {
      const width = cutLength && cutLength < canvas.width
        ? cutLength
        : canvas.width;
      const leftEdge = 0;
      const rightEdge = width;

      ctx.moveTo(leftEdge, 0);
      ctx.lineTo(leftEdge, clipInfo.cutHeight);
      ctx.lineTo(rightEdge, clipInfo.cutHeight);
      const invertedCutAngle = Math.PI + clipInfo.cutAngle;
      const angledX = rightEdge - Math.cos(invertedCutAngle) * canvasDiagonal;
      const angledY = clipInfo.cutHeight + Math.sin(invertedCutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.closePath();
      ctx.clip();

      ctx.beginPath();
      ctx.rect(leftEdge, 0, rightEdge, canvas.height);
      ctx.clip();
    } else {
      const width = cutLength || canvas.width;
      const leftEdge = 0.5 * canvas.width - 0.5 * width;
      const rightEdge = 0.5 * canvas.width + 0.5 * width;

      ctx.moveTo(leftEdge, clipInfo.cutHeight);
      ctx.lineTo(rightEdge, clipInfo.cutHeight);
      ctx.lineTo(rightEdge, 0);
      const invertedCutAngle = Math.PI + clipInfo.cutAngle;
      const angledX = leftEdge + Math.cos(invertedCutAngle) * canvasDiagonal;
      const angledY = clipInfo.cutHeight + Math.sin(invertedCutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.closePath();
      ctx.clip();

      ctx.beginPath();
      ctx.rect(0, 0, rightEdge, canvas.height);
      ctx.clip();
    }

    if (img.complete) {
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      const result = canvas.toDataURL();
      if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
        clipInfoHashToBase64.leftTurn.set(clipInfoHashCode, {
          base64: result,
          clipInfo,
        });
      }

      res(result);
    } else {
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        ctx.restore();

        const result = canvas.toDataURL();
        if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
          clipInfoHashToBase64.leftTurn.set(clipInfoHashCode, {
            base64: result,
            clipInfo,
          });
        }

        res(result);
      };
    }
  });
}

/**
 * Clip an icon without any angled corner geometry, optionally trimming one or
 * both straight ends.
 * @param {Object} options Clip inputs and canvas dimensions.
 * @returns {Promise<string>} Data URL of the clipped image.
 */
function getClippedImageNoAngle(options) {
  const img = options.img;
  const clipInfo = options.clipInfo;
  const canvasWidth = options.canvasWidth;
  const canvasHeight = options.canvasHeight;

  return new Promise((res, _) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    if (clipInfo.cutLength === undefined
      || clipInfo.cutLength === null
      || clipInfo.cutLength >= canvasWidth) {
      // No reason to cut, return unchanged
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      return res(canvas.toDataURL());
    }

    const clipInfoHashCode = getHashCode({
      cutLength: clipInfo.cutLength,
      cutInFront: clipInfo.cutInFront,
      cutOnBothEnds: clipInfo.cutOnBothEnds,
      img: img.src,
    });
    if (USE_CACHING && clipInfoHashToBase64.straight.has(clipInfoHashCode)) {
      return res(clipInfoHashToBase64.straight.get(clipInfoHashCode).base64);
    }

    ctx.beginPath();

    if (clipInfo.cutInFront) {
      ctx.rect(canvasWidth - clipInfo.cutLength, 0, canvasWidth, canvas.height);
    } else if (clipInfo.cutOnBothEnds) {
      ctx.rect(0.5 * clipInfo.cutLength, 0, canvasWidth - clipInfo.cutLength, canvas.height);
    } else {
      ctx.rect(0, 0, clipInfo.cutLength, canvas.height);
    }

    ctx.clip();

    if (img.complete) {
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      const result = canvas.toDataURL();
      if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
        // We don't cache empty canvasses
        clipInfoHashToBase64.straight.set(clipInfoHashCode, {
          base64: result,
          clipInfo: clipInfo,
        });
      }

      res(result);
    } else {
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        ctx.restore();

        const result = canvas.toDataURL();
        if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
          // We don't cache empty canvasses
          clipInfoHashToBase64.straight.set(clipInfoHashCode, {
            base64: result,
            clipInfo: clipInfo,
          });
        }

        res(result);
      };
    }
  });
}

/**
 * Rendering the point, including a fallback if img is not loaded yet, retrying in 10ms.
 * @param options
 */
function renderPoint(options) {
  const {
    image,
    angle,
    coords,
    renderToUse,
    pixelRatio,
    renderSession,
    feature,
  } = options;

  // If this render session is not current, don't render anything here.
  if (currentRenderSessionByFeatureOlUid.get(feature.ol_uid) !== renderSession) {
    return;
  }

  const imgElement = image.getImage(pixelRatio);

  // Check if image is ready
  if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) {
    // Recursively call this function once the image is read
    imgElement.onload = () => renderPoint({
      image,
      angle,
      coords,
      renderToUse,
      pixelRatio,
      renderSession,
      feature,
    });
    return;
  }

  const imageAngle = image.getRotation() + angle;
  patchRenderer(renderToUse);
  renderToUse.setImageStyle2(image, imageAngle);
  const pointToDraw = new Point([
    coords[0] / pixelRatio,
    coords[1] / pixelRatio,
  ]);

  renderToUse.drawPoint(pointToDraw);
}

/**
 * Build a deterministic numeric hash for cache keys derived from shallow
 * objects of primitive values.
 * @param {Object} object Source object for the hash.
 * @returns {number} Numeric hash code.
 */
function getHashCode(object) {
  if (!USE_CACHING) {
    return 1;
  }

  const keys = Object.keys(object)
    .sort();
  let hash = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = object[key];

    // Hash the key
    for (let j = 0; j < key.length; j++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(j);
      hash = hash & hash;
    }

    // Hash the value based on its type
    if (typeof value === 'number') {
      // Convert number to string with high precision to ensure uniqueness
      // This prevents hash collisions for slightly different float values
      // const numberString = value.toPrecision(15);
      const numberString = value.toPrecision(11);
      for (let j = 0; j < numberString.length; j++) {
        hash = ((hash << 5) - hash) + numberString.charCodeAt(j);
        hash = hash & hash;
      }
    } else if (typeof value === 'boolean') {
      hash = ((hash << 5) - hash) + (value ? 1 : 0);
    } else if (typeof value === 'string') {
      for (let j = 0; j < value.length; j++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(j);
        hash = hash & hash;
      }
    }
    hash = hash & hash;
  }

  return hash;
}

/**
 * Compare a canvas data URL against the cached empty-canvas output for the same
 * dimensions.
 * @param {string} canvasSrc Canvas data URL to test.
 * @param {number} canvasWidth Canvas width in pixels.
 * @param {number} canvasHeight Canvas height in pixels.
 * @returns {boolean} `true` when the canvas is empty.
 */
function isCanvasEmpty(canvasSrc, canvasWidth, canvasHeight) {
  // if (!emptyCanvasSrc) {
  //   const emptyCanvas = document.createElement('canvas');
  //   emptyCanvas.width = canvasWidth;
  //   emptyCanvas.height = canvasHeight;
  //   emptyCanvasSrc = emptyCanvas.toDataURL();
  // }
  //
  // return canvasSrc === emptyCanvasSrc;

  // Create a unique key for this canvas size
  const sizeKey = `${canvasWidth}x${canvasHeight}`;

  // Use a Map to cache empty canvas data URLs by size
  if (!window._emptyCanvasCache) {
    window._emptyCanvasCache = new Map();
  }

  if (!window._emptyCanvasCache.has(sizeKey)) {
    const emptyCanvas = document.createElement('canvas');
    emptyCanvas.width = canvasWidth;
    emptyCanvas.height = canvasHeight;
    window._emptyCanvasCache.set(sizeKey, emptyCanvas.toDataURL());
  }

  return canvasSrc === window._emptyCanvasCache.get(sizeKey);

}

/**
 * Create a DOM image element for a source URL so it can be used by the canvas
 * clipping helpers.
 * @param {string} src Image source URL or data URL.
 * @returns {HTMLImageElement} Image element with the source assigned.
 */
function createDomImage(src) {
  const img = new Image();
  img.src = src;
  return img;
}

/**
 * Run a clipping helper and wrap the resulting data URL back into an OpenLayers
 * icon with the requested anchor.
 * @param {Object} options Clip configuration and source icon.
 * @returns {Promise<Icon>} Clipped OpenLayers icon.
 */
async function clipToIcon(options) {
  const {
    imageStyle,
    clipper,
    clipInfo,
    canvasSize,
    anchor,
    clipperOptions = {},
  } = options;

  const imgSize = getImageStyleSize(imageStyle);
  const scale = imageStyle.getScale();
  const [canvasWidth, canvasHeight] = canvasSize || imgSize;
  const img = createDomImage(getImageStyleSrc(imageStyle));
  const clippedSrc = await clipper({
    img,
    clipInfo,
    canvasWidth,
    canvasHeight,
    ...clipperOptions,
  });

  return createOlIconWithDataURL({
    src: clippedSrc,
    imgSize,
    scale,
    anchor,
  });
}

/**
 * Resolve the source URL used by an OpenLayers icon style.
 * @param {Icon} imageStyle OpenLayers icon style.
 * @returns {string|undefined} Image source URL.
 */
function getImageStyleSrc(imageStyle) {
  return imageStyle.iconImage_?.src_ || imageStyle.getSrc?.();
}

/**
 * Resolve the pixel size used by an OpenLayers icon style across OL versions.
 * @param {Icon} imageStyle OpenLayers icon style.
 * @returns {Array<number>|undefined} Image size as `[width, height]`.
 */
function getImageStyleSize(imageStyle) {
  return imageStyle.getSize?.()
    || imageStyle.imgSize_
    || imageStyle.size_
    || imageStyle.iconImage_?.size_;
}

/**
 * Used to handle image src loading, because leaving that up to OL sometimes causes the images to not render.
 * @param {Object} options Configuration options for creating the icon
 * @param {string} options.src The data URL source of the icon image
 * @param {Array<number>} options.imgSize The size of the image in pixels [width, height]
 * @param {number} options.scale The scale factor to apply to the image
 * @param {Array<number>} options.anchor The anchor point of the icon as fraction [x, y]
 * @returns {Icon} An OpenLayers Icon instance with the specified image and settings
 */
function createOlIconWithDataURL(options) {
  const {
    src,
    imgSize,
    scale,
    anchor,
  } = options;

  const tempImg = new Image();
  tempImg.src = src;
  if (imgSize && imgSize[0] && imgSize[1]) {
    tempImg.width = imgSize[0];
    tempImg.height = imgSize[1];
  }

  const icon = new Icon({
    img: tempImg,
    imgSize: imgSize,
    size: imgSize, // OL10 needs size when img is provided
    scale: scale,
    anchor: anchor,
    anchorXUnits: 'fraction',
    anchorYUnits: 'fraction',
  });

  return icon;
}

/**
 * Create a renderer function for rendering GraphicStroke marks
 * to be used inside an OpenLayers Style.renderer function.
 * @private
 * @param {LineSymbolizer} linesymbolizer SLD line symbolizer object.
 * @param {Function} getProperty A property getter: (feature, propertyName) => property value.
 * @returns {ol/style/Style~RenderFunction} A style renderer function (pixelCoords, renderState) => void.
 */
export function getGraphicStrokeRenderer(linesymbolizer, getProperty) {
  if (!(linesymbolizer.stroke && linesymbolizer.stroke.graphicstroke)) {
    throw new Error(
      'getGraphicStrokeRenderer error: symbolizer.stroke.graphicstroke null or undefined.',
    );
  }

  const { graphicstroke } = linesymbolizer.stroke;

  const options = {
    placement: PLACEMENT_DEFAULT,
  };

  // QGIS vendor options to override graphicstroke symbol placement.
  if (linesymbolizer.vendoroptions) {
    if (linesymbolizer.vendoroptions.placement === 'firstPoint') {
      options.placement = PLACEMENT_FIRSTPOINT;
    } else if (linesymbolizer.vendoroptions.placement === 'lastPoint') {
      options.placement = PLACEMENT_LASTPOINT;
    }
  }

  return (pixelCoords, renderState) => {
    // Abort when feature geometry is (Multi)Point.
    const geometryType = renderState.feature.getGeometry()
      .getType();
    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      return;
    }

    const pixelRatio = renderState.pixelRatio || 1.0;

    // TODO: Error handling, alternatives, etc.
    const renderContext = renderState.context;

    let defaultGraphicSize = DEFAULT_MARK_SIZE;
    if (graphicstroke.graphic && graphicstroke.graphic.externalgraphic) {
      defaultGraphicSize = DEFAULT_EXTERNALGRAPHIC_SIZE;
    }

    const pointStyle = getPointStyle(
      graphicstroke,
      renderState.feature,
      getProperty,
    );

    // Calculate graphic spacing.
    // Graphic spacing equals the center-to-center distance of graphics along the line.
    // If there's no gap, segment length will be equal to graphic size.
    const graphicSizeExpression =
      (graphicstroke.graphic && graphicstroke.graphic.size) ||
      defaultGraphicSize;
    const graphicSize = Number(
      evaluate(
        graphicSizeExpression,
        renderState.feature,
        getProperty,
        defaultGraphicSize,
      ),
    );

    const graphicSpacing = calculateGraphicSpacing(linesymbolizer, graphicSize);
    options.initialGap = getInitialGapSize(linesymbolizer);

    renderStrokeMarks(
      renderContext,
      pixelCoords,
      graphicSpacing,
      pointStyle,
      pixelRatio,
      options,
      geometryType,
      renderState.feature,
    );
  };
}

/**
 * Create an OpenLayers style for rendering line symbolizers with a GraphicStroke.
 * @private
 * @param {LineSymbolizer} linesymbolizer SLD line symbolizer object.
 * @param {Function} getProperty A property getter: (feature, propertyName) => property value.
 * @returns {ol/style/Style} An OpenLayers style instance.
 */
function getGraphicStrokeStyle(linesymbolizer, getProperty) {
  if (!(linesymbolizer.stroke && linesymbolizer.stroke.graphicstroke)) {
    throw new Error(
      'getGraphicStrokeStyle error: linesymbolizer.stroke.graphicstroke null or undefined.',
    );
  }

  return new Style({
    renderer: getGraphicStrokeRenderer(linesymbolizer, getProperty),
  });
}

export default getGraphicStrokeStyle;
