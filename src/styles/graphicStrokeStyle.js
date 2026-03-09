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
const USE_CACHING = true;

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

    let newPointsDataToRender;
    if (isRightTurn) {
      newPointsDataToRender = await handleRightTurn({
        currentGeometryCoordIndex: currentGeometryCoordIndex,
        pointsDataToRender: pointsDataToRender,
        pImage: ogImage,
        pImageWidth: ogImageWidth,
        pImageHeight: ogImageHeight,
        pRenderContext: renderContext,
        pPixelRatio: pixelRatio,
        ogImageWidth: ogImageWidth,
        ogImageHeight: ogImageHeight,
        splitPoint: point,
        gapSize: gapSize,
        onlyDoGap: false,
        involvedGeometryCoords: {
          coordOnFirstLine: pixelCoords[currentGeometryCoordIndex - 1],
          intersectCoord: pixelCoords[currentGeometryCoordIndex],
          coordOnSecondLine: pixelCoords[currentGeometryCoordIndex + 1],
        },
      });
    }
    else if (isLeftTurn) {
      newPointsDataToRender = await handleLeftTurn({
        currentGeometryCoordIndex: currentGeometryCoordIndex,
        pointsDataToRender: pointsDataToRender,
        pImage: ogImage,
        pImageWidth: ogImageWidth,
        pImageHeight: ogImageHeight,
        pRenderContext: renderContext,
        pPixelRatio: pixelRatio,
        ogImageWidth: ogImageWidth,
        ogImageHeight: ogImageHeight,
        splitPoint: point,
        gapSize,
        onlyDoGap: false,
        involvedGeometryCoords: {
          coordOnFirstLine: pixelCoords[currentGeometryCoordIndex - 1],
          intersectCoord: pixelCoords[currentGeometryCoordIndex],
          coordOnSecondLine: pixelCoords[currentGeometryCoordIndex + 1],
        },
      });
    }
    else if (isRegularButShortened) {
      newPointsDataToRender = await handleRegularButShortened({
        point,
        gapSize,
        ogImageWidth,
        ogImageHeight,
        ogImage,
        pixelRatio,
        image,
        renderCoords,
        customRender,
        currentGeometryCoordIndex,
      });
    }
    else {
      // Unchanged render
      newPointsDataToRender = [
        {
          // ignore: true,
          image: image,
          angle: point.angle,
          coords: renderCoords,
          rendererToUse: customRender,
          geometryCoordIndex: currentGeometryCoordIndex,
        },
      ];
    }

    // Polygon closing handling
    const isPolygon = geometryType.includes('olygon');
    if (isPolygon) {
      const isLastSplitPoint = i === splitPoints.length - 1;
      if (isLastSplitPoint) {
        const hasAdditionalPixelCoord = point.startingGeometryCoordIndex === pixelCoords.length - 2;
        if (hasAdditionalPixelCoord) {
          const nextPixelIsClosingPoint = point.startingGeometryCoordIndex !== 0
            && pixelCoords[point.startingGeometryCoordIndex + 1][0] === pixelCoords[0][0]
            && pixelCoords[point.startingGeometryCoordIndex + 1][1] === pixelCoords[0][1];
          if (nextPixelIsClosingPoint) {
            const lastSplitPoint = point;
            const firstSplitPoint = splitPoints[0];
            const endOfPolygonIsRightTurn = getIsRightTurn(
              pixelCoords[lastSplitPoint.startingGeometryCoordIndex],
              pixelCoords[lastSplitPoint.startingGeometryCoordIndex + 1], // Is the same as [0]
              pixelCoords[1],
            );
            const endOfPolygonGapFillRenderData = endOfPolygonIsRightTurn
              ? await handleRightTurn({
                currentGeometryCoordIndex: firstSplitPoint.startingGeometryCoordIndex,
                pointsDataToRender: pointsDataToRender,
                pImage: ogImage,
                pImageWidth: ogImageWidth,
                pImageHeight: ogImageHeight,
                pRenderContext: renderContext,
                pPixelRatio: pixelRatio,
                ogImageWidth: ogImageWidth,
                ogImageHeight: ogImageHeight,
                splitPoint: firstSplitPoint,
                gapSize: gapSize,
                onlyDoGap: true,
                involvedGeometryCoords: {
                  coordOnFirstLine: pixelCoords[lastSplitPoint.startingGeometryCoordIndex],
                  intersectCoord: pixelCoords[0],
                  coordOnSecondLine: pixelCoords[1],
                },
              })
              : await handleLeftTurn({
                currentGeometryCoordIndex: firstSplitPoint.startingGeometryCoordIndex,
                pointsDataToRender: pointsDataToRender,
                pImage: ogImage,
                pImageWidth: ogImageWidth,
                pImageHeight: ogImageHeight,
                pRenderContext: renderContext,
                pPixelRatio: pixelRatio,
                ogImageWidth: ogImageWidth,
                ogImageHeight: ogImageHeight,
                splitPoint: firstSplitPoint,
                gapSize: gapSize,
                onlyDoGap: true,
                involvedGeometryCoords: {
                  coordOnFirstLine: pixelCoords[lastSplitPoint.startingGeometryCoordIndex],
                  intersectCoord: pixelCoords[0],
                  coordOnSecondLine: pixelCoords[1],
                },
              });
            newPointsDataToRender.push(endOfPolygonGapFillRenderData[0]);
            newPointsDataToRender.push(endOfPolygonGapFillRenderData[1]);
          }
        }
      }
    }
    // end/ Polygon closing handling

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

async function handleRightTurn(options) {
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

    //let gapCloserImage = await deepCloneImage(pImage);

    // This happens when the angle is so narrow, that the length of the corner is larger than the image width.
    // We cannot sensibly cut here, we'd have to add another point. Instead, we cut the second half in the beginning to match the first.
    if (!gapCloserPoint.isFirst && gapCloserPoints[0].cutLength > pImageWidth) {
      gapCloserPoint.cutInFront = gapCloserPoints[0].cutLength - pImageWidth;
    }

    let gapCloserImage = new Image();
    gapCloserImage.src = pImage.iconImage_.src_;
    document.body.appendChild(gapCloserImage);

    const clippedSrc = await getClippedImageForRightTurn({
      img: gapCloserImage,
      clipInfo: gapCloserPoint,
      canvasWidth: ogImageWidth,
      canvasHeight: ogImageHeight,
    });
    const imageAnchor = gapCloserPoint.isFirst
      ? [0, 0.5]
      : [1, 0.5];
    gapCloserImage = createOlIconWithDataURL({
      src: clippedSrc,
      imgSize: [pImageWidth, pImageHeight],
      scale: pImage.getScale(),
      anchor: imageAnchor,
    });
    // gapCloserImage = new Icon({
    //   src: clippedSrc,
    //   imgSize: [pImageWidth, pImageHeight],
    //   scale: pImage.getScale(),
    //   anchor: imageAnchor,
    //   anchorXUnits: 'fraction',
    //   anchorYUnits: 'fraction',
    // });
    // gapCloserImage.getImage(pPixelRatio).src = clippedSrc;

    const gapCloserRenderer = toContext(pRenderContext);

    gapCloserRenderPoints.push({
      image: gapCloserImage,
      angle: gapCloserPoint.angle,
      coords: gapCloserPoint.intersectCoords,
      rendererToUse: gapCloserRenderer,
      isFirstOfRightTurn: gapCloserPoint.isFirst,
      isSecondOfRightTurn: !gapCloserPoint.isFirst,
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
  //const clonedImage = await deepCloneImage(pImage);
  const img = new Image();
  // img.src = clonedImage.getSrc();
  img.src = pImage.iconImage_.src_;
  document.body.appendChild(img);

  const nextSegmentClippedSrc = await getClippedImageNoAngle({
    img: img,
    clipInfo: nextSegmentClipInfo,
    canvasWidth: ogImageWidth,
    canvasHeight: ogImageHeight,
  });
  const nextSegmentImageAnchor = [0, 0.5];
  const nextSegmentImage = createOlIconWithDataURL({
    src: nextSegmentClippedSrc,
    imgSize: [pImageWidth, pImageHeight],
    scale: pImage.getScale(),
    anchor: nextSegmentImageAnchor,
  });
  // const nextSegmentImage = new Icon({
  //   src: nextSegmentClippedSrc,
  //   imgSize: [pImageWidth, pImageHeight],
  //   scale: pImage.getScale(),
  //   anchor: nextSegmentImageAnchor,
  //   anchorXUnits: 'fraction',
  //   anchorYUnits: 'fraction',
  // });
  // nextSegmentImage.getImage(pPixelRatio).src = nextSegmentClippedSrc;

  const nextSegmentRenderer = toContext(pRenderContext);

  const nextSegmentRenderPoint = {
    // ignore: true,
    image: nextSegmentImage,
    angle: gapCloserPointData.backwardPoint.angle,
    coords: gapCloserPointData.backwardPoint.intersectCoords,
    rendererToUse: nextSegmentRenderer,
    geometryCoordIndex: currentGeometryCoordIndex,
    isFirstAfterRightTurn: true,
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

async function handleRegularButShortened(options) {
  const point = options.point;
  const gapSize = options.gapSize;
  const ogImageWidth = options.ogImageWidth;
  const ogImageHeight = options.ogImageHeight;
  const ogImage = options.ogImage;
  const pixelRatio = options.pixelRatio;
  let image = options.image;
  const renderCoords = options.renderCoords;
  const customRender = options.customRender;
  const currentGeometryCoordIndex = options.currentGeometryCoordIndex;

  //image = await deepCloneImage(ogImage);
  const img = new Image();
  // img.src = image.getSrc();
  img.src = ogImage.iconImage_.src_;
  document.body.appendChild(img);
  const cutRatio = point.segmentLength / gapSize;
  const cutLength = cutRatio * ogImageWidth;
  const clippedSrc = await getClippedImageNoAngle({
    img: img,
    clipInfo: {
      cutLength: point.isFirstOfGeometry
        ? ogImageWidth - cutLength
        : cutLength,
      cutInFront: false,
      cutOnBothEnds: point.isFirstOfGeometry,
    },
    canvasWidth: ogImageWidth,
    canvasHeight: ogImageHeight,
  });
  const imageAnchor = point.isFirstOfGeometry
    ? [0.5, 0.5]
    : [0, 0.5];
  image = createOlIconWithDataURL({
    src: clippedSrc,
    imgSize: [ogImageWidth, ogImageHeight],
    scale: ogImage.getScale(),
    anchor: imageAnchor,
  });
  // image = new Icon({
  //   src: clippedSrc,
  //   imgSize: [ogImageWidth, ogImageHeight],
  //   scale: ogImage.getScale(),
  //   anchor: imageAnchor,
  //   anchorXUnits: 'fraction',
  //   anchorYUnits: 'fraction',
  // });
  // image.getImage(pixelRatio).src = clippedSrc;

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

async function handleLeftTurn(options) {
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

    //let gapCloserImage = await deepCloneImage(pImage);

    // This happens when the angle is so narrow, that the length of the corner is larger than the image width.
    // We cannot sensibly cut here, we'd have to add another point. Instead, we cut the second half in the beginning to match the first.
    if (!gapCloserPoint.isFirst && gapCloserPoints[0].cutLength > pImageWidth) {
      gapCloserPoint.cutInFront = gapCloserPoints[0].cutLength - pImageWidth;
    }

    let gapCloserImage = new Image();
    gapCloserImage.src = pImage.iconImage_.src_;
    document.body.appendChild(gapCloserImage);

    const clippedSrc = await getClippedImageForLeftTurn({
      img: gapCloserImage,
      clipInfo: gapCloserPoint,
      canvasWidth: ogImageWidth,
      canvasHeight: ogImageHeight,
    });
    const imageAnchor = gapCloserPoint.isFirst
      ? [0, 0.5]
      : [1, 0.5];
    gapCloserImage = createOlIconWithDataURL({
      src: clippedSrc,
      imgSize: [pImageWidth, pImageHeight],
      scale: pImage.getScale(),
      anchor: imageAnchor,
    });
    // gapCloserImage = new Icon({
    //   src: clippedSrc,
    //   imgSize: [pImageWidth, pImageHeight],
    //   scale: pImage.getScale(),
    //   anchor: imageAnchor,
    //   anchorXUnits: 'fraction',
    //   anchorYUnits: 'fraction',
    // });
    // gapCloserImage.getImage(pPixelRatio).src = clippedSrc;

    const gapCloserRenderer = toContext(pRenderContext);

    gapCloserRenderPoints.push({
      image: gapCloserImage,
      angle: gapCloserPoint.angle,
      coords: gapCloserPoint.intersectCoords,
      rendererToUse: gapCloserRenderer,
      isFirstOfLeftTurn: gapCloserPoint.isFirst,
      isSecondOfLeftTurn: !gapCloserPoint.isFirst,
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
  //const clonedImage = await deepCloneImage(pImage);
  const img = new Image();
  // img.src = clonedImage.getSrc();
  img.src = pImage.iconImage_.src_;
  document.body.appendChild(img);

  const nextSegmentClippedSrc = await getClippedImageNoAngle({
    img: img,
    clipInfo: nextSegmentClipInfo,
    canvasWidth: ogImageWidth,
    canvasHeight: ogImageHeight,
  });
  const nextSegmentImageAnchor = [0, 0.5];
  const nextSegmentImage = createOlIconWithDataURL({
    src: nextSegmentClippedSrc,
    imgSize: [pImageWidth, pImageHeight],
    scale: pImage.getScale(),
    anchor: nextSegmentImageAnchor,
  });
  // const nextSegmentImage = new Icon({
  //   src: nextSegmentClippedSrc,
  //   imgSize: [pImageWidth, pImageHeight],
  //   scale: pImage.getScale(),
  //   anchor: nextSegmentImageAnchor,
  //   anchorXUnits: 'fraction',
  //   anchorYUnits: 'fraction',
  // });
  // nextSegmentImage.getImage(pPixelRatio).src = nextSegmentClippedSrc;

  const nextSegmentRenderer = toContext(pRenderContext);

  const nextSegmentRenderPoint = {
    // ignore: true,
    image: nextSegmentImage,
    angle: gapCloserPointData.backwardPoint.angle,
    coords: gapCloserPointData.backwardPoint.intersectCoords,
    rendererToUse: nextSegmentRenderer,
    geometryCoordIndex: currentGeometryCoordIndex,
    isFirstAfterLeftTurn: true,
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

function getClippedImageForRightTurn(options) {
  const img = options.img;
  const clipInfo = options.clipInfo;
  const canvasWidth = options.canvasWidth;
  const canvasHeight = options.canvasHeight;

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
    if (USE_CACHING && clipInfoHashToBase64.rightTurn.has(clipInfoHashCode)) {
      return res(clipInfoHashToBase64.rightTurn.get(clipInfoHashCode).base64);
    }

    ctx.save();
    ctx.beginPath();

    if (clipInfo.isFirst) {
      ctx.moveTo(0, 0);
      ctx.lineTo(cutLength, 0);
      const angledX = cutLength + Math.cos(Math.PI - clipInfo.cutAngle) * canvasDiagonal;
      const angledY = Math.sin(clipInfo.cutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(0, canvas.height);
      ctx.closePath();
      ctx.clip();
    } else {
      ctx.moveTo(canvasWidth, 0);
      ctx.lineTo(canvasWidth - cutLength, 0);
      const angledX = canvasWidth - cutLength + Math.cos(clipInfo.cutAngle) * canvasDiagonal;
      const angledY = Math.sin(clipInfo.cutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(canvasWidth, canvasHeight);
      ctx.closePath();
      ctx.clip();
    }

    if (img.complete) {
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      const result = canvas.toDataURL();
      if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
        // We don't cache empty canvasses
        clipInfoHashToBase64.rightTurn.set(clipInfoHashCode, {
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
          clipInfoHashToBase64.rightTurn.set(clipInfoHashCode, {
            base64: result,
            clipInfo: clipInfo,
          });
        }
        res(result);
      };
    }
  });
}

function getClippedImageForLeftTurn(options) {
  const img = options.img;
  const clipInfo = options.clipInfo;
  const canvasWidth = options.canvasWidth;
  const canvasHeight = options.canvasHeight;

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
    if (USE_CACHING && clipInfoHashToBase64.leftTurn.has(clipInfoHashCode)) {
      return res(clipInfoHashToBase64.leftTurn.get(clipInfoHashCode).base64);
    }

    ctx.save();
    ctx.beginPath();

    if (clipInfo.isFirst) {
      ctx.moveTo(0, canvasHeight);
      ctx.lineTo(cutLength, canvasHeight);
      const angledX = cutLength + Math.cos(Math.PI - clipInfo.cutAngle) * canvasDiagonal;
      const angledY = canvasHeight - Math.sin(clipInfo.cutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.clip();
    } else {
      ctx.moveTo(canvasWidth, canvasHeight);
      ctx.lineTo(canvasWidth - cutLength, canvasHeight);
      const angledX = canvasWidth - cutLength + Math.cos(clipInfo.cutAngle) * canvasDiagonal;
      const angledY = canvasHeight - Math.sin(clipInfo.cutAngle) * canvasDiagonal;
      ctx.lineTo(angledX, angledY);
      ctx.lineTo(canvasWidth, 0);
      ctx.closePath();
      ctx.clip();
    }

    if (img.complete) {
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      const result = canvas.toDataURL();
      if (!isCanvasEmpty(result, canvasWidth, canvasHeight)) {
        // We don't cache empty canvasses
        clipInfoHashToBase64.leftTurn.set(clipInfoHashCode, {
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
          clipInfoHashToBase64.leftTurn.set(clipInfoHashCode, {
            base64: result,
            clipInfo: clipInfo,
          });
        }

        res(result);
      };
    }
  });
}

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

// Not quite a deep clone, but deep cloning the properties we need for rendering.
// We do this to not affect all individually rendered images when adjusting some of them.
async function deepCloneImage(image) {

  return new Promise((res, _) => {
    if (image.getImage().complete) {
      const copy = image.clone();

      copy.imgSize_ = structuredClone(image.imgSize_);
      copy.iconImage_ = new image.iconImage_.__proto__.constructor(
        image.iconImage_.image_,
        image.iconImage_.src_,
        [image.iconImage_.size_[0], image.iconImage_.size_[1]],
        image.iconImage_.crossOrigin_,
        image.iconImage_.imageState_,
        image.iconImage_.color_,
      );

      res(copy);
    } else {
      image.getImage().onload = () => {
        const copy = image.clone();

        copy.imgSize_ = structuredClone(image.imgSize_);
        copy.iconImage_ = new image.iconImage_.__proto__.constructor(
          image.iconImage_.image_,
          image.iconImage_.src_,
          [image.iconImage_.size_[0], image.iconImage_.size_[1]],
          image.iconImage_.crossOrigin_,
          image.iconImage_.imageState_,
          image.iconImage_.color_,
        );

        res(copy);
      };
    }
  });
}

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
