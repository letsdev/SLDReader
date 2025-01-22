import { containsCoordinate } from 'ol/extent';

import { PLACEMENT_FIRSTPOINT, PLACEMENT_LASTPOINT } from '../constants';

/**
 * Euclidean distance between two points ([x, y]).
 */
function calculatePointsDistance(coord1, coord2) {
  const dx = coord1[0] - coord2[0];
  const dy = coord1[1] - coord2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculates a point along the line between the provided startCoord and endCoord. The distance between the 
 * startCoord and the resulting point will be exactly `distanceFromStart`. The resulting point will never lie
 * outside of the provided segment. If a graphicWidth is provided, and this width is larger than the segment 
 * length, the point will be placed exactly in the middle of the segment.
 */
function calculateSplitPointCoords(options) {
  const startCoord = options.startCoord;
  const endCoord = options.endCoord;
  const distanceFromStart = options.distanceFromStart;

  var distanceBetweenNodes = calculatePointsDistance(startCoord, endCoord);
  let d = Math.max(Math.min(distanceFromStart / distanceBetweenNodes, 1), 0); // clamp this between 0 and 1 to prevent points outside of the segment
  if (!!options.graphicWidth && options.graphicWidth > distanceBetweenNodes) {
    d = 0.5;
  }
  var x = startCoord[0] + (endCoord[0] - startCoord[0]) * d;
  var y = startCoord[1] + (endCoord[1] - startCoord[1]) * d;
  return [x, y];
}

/**
 * Calculate the angle of a vector in radians clockwise from the positive x-axis.
 * Example: (0,0) -> (1,1) --> -pi/4 radians.
 * @private
 * @param {Array<number>} p1 Start of the line segment as [x,y].
 * @param {Array<number>} p2 End of the line segment as [x,y].
 * @param {boolean} invertY If true, calculate with Y-axis pointing downwards.
 * @returns {number} Angle in radians, clockwise from the positive x-axis.
 */
function calculateAngle(p1, p2, invertY) {
  const dX = p2[0] - p1[0];
  const dY = p2[1] - p1[1];
  const angle = -Math.atan2(invertY ? -dY : dY, dX);
  return angle;
}

// eslint-disable-next-line import/prefer-default-export
/**
 * Creates a list of anchor points for images that will be rendered as a geometry line. Each point will be the center of 
 * such an image. The returned "splitPoints" include coordinates, angle, and in certain cases the length of the segment the point is on. 
 */
export function splitLineString(geometry, graphicSpacing, options = {}) {
  const coords = geometry.getCoordinates();

  // Handle degenerate cases.
  // LineString without points
  if (coords.length === 0) {
    return [];
  }

  // LineString containing only one point.
  if (coords.length === 1) {
    return [(coords[0]).concat([0])];
  }

  // Handle first point placement case.
  if (options.placement === PLACEMENT_FIRSTPOINT) {
    var p1 = coords[0];
    var p2 = coords[1];
    return [[p1[0], p1[1], calculateAngle(p1, p2, options.invertY)]];
  }

  // Handle last point placement case.
  if (options.placement === PLACEMENT_LASTPOINT) {
    var p1$1 = coords[coords.length - 2];
    var p2$1 = coords[coords.length - 1];
    return [[p2$1[0], p2$1[1], calculateAngle(p1$1, p2$1, options.invertY)]];
  }

  var gapSize = Math.max(graphicSpacing, 0.1); // 0.1 px minimum gap size to prevent accidents.

  var pointIndex = 0;
  var currentSegmentStart = [].concat(coords[0]);
  var currentSegmentEnd = [].concat(coords[1]);

  var splitPoints = [];

  let splitPointsOnThisSegment = 0;

  // Keep adding points until the next point measure lies beyond the line length.
  while (true) {
    var currentSegmentLength = calculatePointsDistance(
      currentSegmentStart,
      currentSegmentEnd
    );

    let distanceFromStart;

    // If the next split point creates a line that is longer than the segment, it will be the last one on the segment. 
    // May also be the only split point.
    if ((splitPointsOnThisSegment + 1) * gapSize >= currentSegmentLength) {

      if (splitPointsOnThisSegment === 0) {
        // We put the first split point at the center of the first image, so half the gapsize away from the start.
        distanceFromStart = 0.5 * gapSize;
      } else {
        // We put the last split point at the center of the last image, so half the gapsize away from the end.
        distanceFromStart = currentSegmentLength - (0.5 * gapSize);
      }

      var splitPointCoords = calculateSplitPointCoords({
        startCoord: currentSegmentStart,
        endCoord: currentSegmentEnd,
        distanceFromStart: distanceFromStart,
        graphicWidth: gapSize
      });
      var angle = calculateAngle(
        currentSegmentStart,
        currentSegmentEnd,
        options.invertY
      );
      // Only return split points that will be rendered (are in extent).
      if (!options.extent
        || extent.containsCoordinate(options.extent, splitPointCoords)) {
        splitPointCoords.push(angle);
        /*
         * If this is the only split point on this segment, we also add the current segment length. This might be used to 
         * calculate the correct image width in the rendering loop that is calling this function, in case the image is
         * wider than the whole segment.
         */
        if (splitPointsOnThisSegment === 0) {
          splitPointCoords.push(currentSegmentLength);
        }
        splitPoints.push(splitPointCoords);
      }

      if (pointIndex === coords.length - 2) {
        // Stop if there is no next segment to process.
        break;
      }
      currentSegmentStart[0] = currentSegmentEnd[0];
      currentSegmentStart[1] = currentSegmentEnd[1];
      currentSegmentEnd[0] = coords[pointIndex + 2][0];
      currentSegmentEnd[1] = coords[pointIndex + 2][1];
      pointIndex += 1;
      splitPointsOnThisSegment = 0;
    } else { // The next split point does *not* exceed the segment length, so it won't be the last one.

      if (splitPointsOnThisSegment === 0) {
        // We put the first split point at the center of the first image, so half the gapsize away from the start.
        distanceFromStart = 0.5 * gapSize;
      } else {
        // We put all other split points (except the last one, but that's handled in the `if` branch) 
        // exactly "one image width apart" (== gapSize) from each other. Since `distanceFromStart` is the total length of the 
        // line computet thus far, we include the half gapsize of the first point, hence `+ 0.5`.
        distanceFromStart = (splitPointsOnThisSegment + 0.5) * gapSize;
      }

      // We don't need to provide the graphic width here, since it can never be longer than the segment once we're in the `else` block.
      var splitPointCoords$1 = calculateSplitPointCoords({
        startCoord: currentSegmentStart,
        endCoord: currentSegmentEnd,
        distanceFromStart: distanceFromStart
      });
      var angle$1 = calculateAngle(
        currentSegmentStart,
        currentSegmentEnd,
        options.invertY
      );
      // Only return split points that will be rendered (are in extent).
      if (
        !options.extent ||
        extent.containsCoordinate(options.extent, splitPointCoords$1)
      ) {
        splitPointCoords$1.push(angle$1);
        // We don't add the segment length here, since the graphic is for sure not wider than the segment once we're in this else block. 
        splitPoints.push(splitPointCoords$1);
      }
      splitPointsOnThisSegment++;
    }
  }

  return splitPoints;
}