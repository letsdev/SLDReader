import { Style } from 'ol/style';
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
import { splitLineString } from './geometryCalcs';

// A flag to prevent multiple renderer patches.
let rendererPatched = false;
function patchRenderer(renderer) {
  if (rendererPatched) {
    return;
  }

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
function renderStrokeMarks(
  renderContext,
  pixelCoords,
  graphicSpacing,
  pointStyle,
  pixelRatio,
  options
) {
  if (!pixelCoords) {
    return;
  }

  // We use the context as param and create the render object here, because we need to create deep copies later.
  const render2 = render.toContext(renderContext);
  patchRenderer(render2);

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
        options
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

  const gapSize = graphicSpacing * pixelRatio;

  var splitPoints = splitLineString(
    new geom.LineString(pixelCoords),
    gapSize,
    {
      invertY: true, // Pixel y-coordinates increase downwards in screen space.
      extent: render2.extent_,
      placement: options.placement,
      initialGap: options.initialGap,
      graphicWidth: ogImage.iconImage_?.image_?.naturalWidth
    }
  );

  // Not quite a deep clone, but deep cloning the properties we need for rendering. 
  // We do this to not affect all individually rendered images when adjusting some of them.
  const deepCloneImage = (image) => {
    const copy = image.clone();

    copy.imgSize_ = structuredClone(image.imgSize_);
    copy.iconImage_ = new image.iconImage_.__proto__.constructor(
      image.iconImage_.image_,
      image.iconImage_.src_,
      [image.iconImage_.size_[0], image.iconImage_.size_[1]],
      image.iconImage_.crossOrigin_,
      image.iconImage_.imageState_,
      image.iconImage_.color_
    );

    return copy;
  }

  let ogImageWidth;
  if (ogImage.imgSize_) {
    ogImageWidth = ogImage.imgSize_[0];
  }

  // This loop renders the individual splitPoints.
  splitPoints.forEach((point) => {
    let customRender = render2;
    let image;

    /* This whole function has some adjustment solely for the case of the graphic being wider than a segment of the geometry.
     * Whenever this case occurs, we change the width of the image that will be rendered for the respective split point.
     * The condition for this case is as follows: `gapSize > segmentLength`, where gapSize is the graphic width in the pixel 
     * space that's used for the splitLineString computation (which produces the splitPoints array), and segmentLength is the 
     * length of the segment that might be too short for the graphic (same pixel space as `gapSize`). 
     * To adjust the image size, we need to apply the ratio of `segmentLength / gapSize` (short segment length / long graphic width)
     * to the actual graphic size, since the graphic width is given in a different pixel space. The resulting value will be the 
     * length of the segment in the pixelspace of the graphic, making the graphic exactly as long as the segment. 
     * (i.e. if `segmentLength` is 2/3 of `gapSize`, we want the image to be rendered 2/3 as wide as the original)
     * For the rendering to work correctly, we need to use a separate render object. Otherwise the image size will be applied to 
     * every rendered image, due to the static way the render object holds the size information. We create a deep copy of the
     * render object for this purpose (only the properties that we require are properly deep copied).
     */
    if (ogImage.iconImage_) {
      image = deepCloneImage(ogImage);

      const hasSegmentLength = point.length > 3;
      if (hasSegmentLength) {
        const segmentLength = point[3];
        if (gapSize > segmentLength) {
          const imageToSegmentRatio = (segmentLength / gapSize);
          const newVal = ogImageWidth * imageToSegmentRatio;
          image.iconImage_.size_[0] = newVal;

          customRender = render.toContext(renderContext);
          patchRenderer(customRender);
        }
      }
    } else {
      image = ogImage;
    }

    var splitPointAngle = image.getRotation() + point[2];
    customRender.setImageStyle2(image, splitPointAngle);
    const pointToDraw = new geom.Point([point[0] / pixelRatio, point[1] / pixelRatio]);
    customRender.drawPoint(pointToDraw);
  });
}

/**
 * Create a renderer function for renderining GraphicStroke marks
 * to be used inside an OpenLayers Style.renderer function.
 * @private
 * @param {LineSymbolizer} linesymbolizer SLD line symbolizer object.
 * @param {Function} getProperty A property getter: (feature, propertyName) => property value.
 * @returns {ol/style/Style~RenderFunction} A style renderer function (pixelCoords, renderState) => void.
 */
export function getGraphicStrokeRenderer(linesymbolizer, getProperty) {
  if (!(linesymbolizer.stroke && linesymbolizer.stroke.graphicstroke)) {
    throw new Error(
      'getGraphicStrokeRenderer error: symbolizer.stroke.graphicstroke null or undefined.'
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
    const geometryType = renderState.feature.getGeometry().getType();
    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      return;
    }

    const pixelRatio = renderState.pixelRatio || 1.0;

    // TODO: Error handling, alternatives, etc.
    // const render = toContext(renderState.context);
    // patchRenderer(render);
    const renderContext = renderState.context;

    let defaultGraphicSize = DEFAULT_MARK_SIZE;
    if (graphicstroke.graphic && graphicstroke.graphic.externalgraphic) {
      defaultGraphicSize = DEFAULT_EXTERNALGRAPHIC_SIZE;
    }

    const pointStyle = getPointStyle(
      graphicstroke,
      renderState.feature,
      getProperty
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
        defaultGraphicSize
      )
    );

    const graphicSpacing = calculateGraphicSpacing(linesymbolizer, graphicSize);
    options.initialGap = getInitialGapSize(linesymbolizer);

    renderStrokeMarks(
      // render,
      renderContext,
      pixelCoords,
      graphicSpacing,
      pointStyle,
      pixelRatio,
      options
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
      'getGraphicStrokeStyle error: linesymbolizer.stroke.graphicstroke null or undefined.'
    );
  }

  return new Style({
    renderer: getGraphicStrokeRenderer(linesymbolizer, getProperty),
  });
}

export default getGraphicStrokeStyle;
