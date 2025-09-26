import { containsCoordinate } from 'ol/extent';

import { PLACEMENT_FIRSTPOINT, PLACEMENT_LASTPOINT } from '../constants';

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
    const p1 = coords[0];
    const p2 = coords[1];
    return [[p1[0], p1[1], calculateAngle(p1, p2, options.invertY)]];
  }
  // Handle last point placement case.
  if (options.placement === PLACEMENT_LASTPOINT) {
    const p1 = coords[coords.length - 2];
    const p2 = coords[coords.length - 1];
    return [[p2[0], p2[1], calculateAngle(p1, p2, options.invertY)]];
  }

  const gapSize = Math.max(graphicSpacing, 0.1); // 0.1 px minimum gap size to prevent accidents.

  let pointIndex = 0;
  const currentSegmentStart = [].concat(coords[0]);
  const currentSegmentEnd = [].concat(coords[1]);

  let splitPointsOnThisSegment = 0;

  const splitPoints = [];
  // Keep adding points until the next point measure lies beyond the line length.
  while (true) {
    const currentSegmentLength = calculatePointsDistance(
      currentSegmentStart,
      currentSegmentEnd,
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

      const splitPointCoords = calculateSplitPointCoords({
        startCoord: currentSegmentStart,
        endCoord: currentSegmentEnd,
        distanceFromStart: distanceFromStart,
        graphicWidth: gapSize,
      });
      const angle = calculateAngle(
        currentSegmentStart,
        currentSegmentEnd,
        options.invertY,
      );
      // Only return split points that will be rendered (are in extent).
      if (!options.extent
        || containsCoordinate(options.extent, splitPointCoords)) {
        const splitPoint = {
          splitPointCoords: splitPointCoords,
          angle: angle,
          startingGeometryCoordIndex: pointIndex,
        };
        /*
         * If this is the only split point on this segment, we also add the current segment length. This might be used to
         * calculate the correct image width in the rendering loop that is calling this function, in case the image is
         * wider than the whole segment.
         */
        if (splitPointsOnThisSegment === 0) {
          splitPoint.segmentLength = currentSegmentLength;
          splitPoint.isOnlySpOnThisSegment = true;
        }
        splitPoints.push(splitPoint);
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
        // line computed thus far, we include the half gapsize of the first point, hence `+ 0.5`.
        distanceFromStart = (splitPointsOnThisSegment + 0.5) * gapSize;
      }

      // We don't need to provide the graphic width here, since it can never be longer than the segment once we're in the `else` block.
      const splitPointCoords = calculateSplitPointCoords({
        startCoord: currentSegmentStart,
        endCoord: currentSegmentEnd,
        distanceFromStart: distanceFromStart,
      });
      const angle = calculateAngle(
        currentSegmentStart,
        currentSegmentEnd,
        options.invertY,
      );
      // Only return split points that will be rendered (are in extent).
      if (
        !options.extent ||
        containsCoordinate(options.extent, splitPointCoords)
      ) {
        // We don't add the segment length here, since the graphic is for sure not wider than the segment once we're in this else block.
        splitPoints.push({
          splitPointCoords: splitPointCoords,
          angle: angle,
          startingGeometryCoordIndex: pointIndex,
        });
      }
      splitPointsOnThisSegment++;
    }
  }

  return splitPoints;
}

export function getGapCloserPoints(options) {
  const coordOnFirstLine = options.coordOnFirstLine;
  const intersectCoord = options.intersectCoord;
  const coordOnSecondLine = options.coordOnSecondLine;
  const mirrorOffset = options.mirrorOffset;

  const isRightTurn = getIsRightTurn(
    coordOnFirstLine,
    intersectCoord,
    coordOnSecondLine,
  );

  const mirroredCoords = getMirroredCoords(
    coordOnFirstLine,
    intersectCoord,
    coordOnSecondLine,
    !isRightTurn,
    mirrorOffset,
  );

  const angleAtMirroredIntersect = angleInRadiansAtB(
    mirroredCoords.coords2,
    mirroredCoords.intersect,
    mirroredCoords.coords3,
  );

  const returnData = {
    forwardPoint: null,
    backwardPoint: null,
    isRightTurn: isRightTurn,
  };

  // Forwards direction
  const angleFwd = calculateAngle(coordOnFirstLine, intersectCoord, true);
  const cutLength = calculatePointsDistance(
    mirroredCoords.coords2,
    mirroredCoords.intersect,
  );
  returnData.forwardPoint = {
    intersectCoords: intersectCoord,
    angle: angleFwd,
    cutLength: cutLength,
    cutAngle: angleAtMirroredIntersect / 2, // We only need half for each of the two gap filling parts.
    isRightTurn: isRightTurn,
    isFirst: true,
  };

  // Backwards direction
  const angleBwd = calculateAngle(intersectCoord, coordOnSecondLine, true);
  returnData.backwardPoint = {
    intersectCoords: intersectCoord,
    mirroredIntersect: mirroredCoords.intersect,
    angle: angleBwd,
    cutLength: calculatePointsDistance(
      mirroredCoords.intersect,
      mirroredCoords.coords3,
    ),
    cutAngle: angleAtMirroredIntersect / 2, // This is the second half.
    isRightTurn: isRightTurn,
    isFirst: false,
  };

  return returnData;
}

export function angleInRadiansAtB(a, b, c) {
  // Vectors AB and CB
  const ab = [a[0] - b[0], a[1] - b[1]];
  const cb = [c[0] - b[0], c[1] - b[1]];

  // Dot product and magnitudes
  const dot = ab[0] * cb[0] + ab[1] * cb[1];
  const magAB = Math.hypot(...ab);
  const magCB = Math.hypot(...cb);

  // Clamp value for safety against floating point errors
  const cosTheta = Math.min(Math.max(dot / (magAB * magCB), -1), 1);

  // Return angle in radians
  return Math.acos(cosTheta);
}

/**
 * Euclidean distance between two points ([x, y]).
 */
export function calculatePointsDistance(coord1, coord2) {
  const dx = coord1[0] - coord2[0];
  const dy = coord1[1] - coord2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function getMirroredCoords(
  coordOnFirstLine,
  intersectCoord,
  coordOnSecondLine,
  useRight,
  offset,
) {
  const mirroredCoords1 = getSidePointFromLine(coordOnFirstLine, intersectCoord, offset, useRight);
  const mirroredCoords2 = getSidePointFromLine(intersectCoord, coordOnFirstLine, offset, !useRight);
  const mirroredCoords3 = getSidePointFromLine(intersectCoord, coordOnSecondLine, offset, useRight);
  const mirroredCoords4 = getSidePointFromLine(coordOnSecondLine, intersectCoord, offset, !useRight);

  const mirroredIntersect = getLineIntersect([
    mirroredCoords1,
    mirroredCoords2,
  ], [
    mirroredCoords4,
    mirroredCoords3,
  ]);

  return {
    coords1: mirroredCoords1,
    coords2: mirroredCoords2,
    coords3: mirroredCoords3,
    coords4: mirroredCoords4,
    intersect: mirroredIntersect,
  };
}

/* Mirror D on C to create E, and then return true if E is contained in the triangle A-B-D */
export function isEInsideTriangleAfterMirror(A, B, C, D) {
  // Mirror D on C to get E
  const E = [
    2 * C[0] - D[0],
    2 * C[1] - D[1],
  ];

  // Helper function to compute the "sign" of area (cross product)
  function sign(p1, p2, p3) {
    return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  }

  const d1 = sign(E, A, B);
  const d2 = sign(E, B, D);
  const d3 = sign(E, D, A);

  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

  // E is inside the triangle if it is not strictly on both sides
  return !(hasNeg && hasPos);
}

export function getIsRightTurn(a, b, c) {
  const mirroredCoords1Right = getSidePointFromLine(a, b, 1, true);
  const mirroredCoords1Left = getSidePointFromLine(a, b, 1, false);
  const d1 = calculatePointsDistance(mirroredCoords1Right, c);
  const d2 = calculatePointsDistance(mirroredCoords1Left, c);
  return d2 > d1;
}

function getSidePointFromLine(point1, point2, distance, getRightSide) {
  // Calculate the direction vector from point1 to point2
  const dx = point2[0] - point1[0];
  const dy = point2[1] - point1[1];

  // Handle degenerate case where points are the same
  if (dx === 0 && dy === 0) {
    return [point1[0], point1[1]]; // Return original point if no direction
  }

  // Calculate perpendicular vector (rotate 90 degrees)
  // For vector (dx, dy), perpendicular vectors are (-dy, dx) and (dy, -dx)
  let perpDx = -dy;
  let perpDy = dx;

  // Normalize to unit vector
  const length = Math.hypot(perpDx, perpDy);
  perpDx /= length;
  perpDy /= length;

  const candidateOne = [
    point1[0] + perpDx * distance,
    point1[1] + perpDy * distance,
  ];
  const candidateTwo = [
    point1[0] + (perpDx * -1) * distance,
    point1[1] + (perpDy * -1) * distance,
  ];

  let candidateOneIsOnTheRight;
  if (point2[0] > point1[0]
    && point2[1] === point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] > candidateTwo[1];
  } else if (point2[0] > point1[0]
    && point2[1] > point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] > candidateTwo[1];
  } else if (point2[0] === point1[0]
    && point2[1] > point1[1]) {
    candidateOneIsOnTheRight = candidateOne[0] < candidateTwo[0];
  } else if (point2[0] < point1[0]
    && point2[1] > point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] < candidateTwo[1];
  } else if (point2[0] < point1[0]
    && point2[1] === point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] < candidateTwo[1];
  } else if (point2[0] < point1[0]
    && point2[1] < point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] < candidateTwo[1];
  } else if (point2[0] === point1[0]
    && point2[1] < point1[1]) {
    candidateOneIsOnTheRight = candidateOne[0] > candidateTwo[0];
  } else if (point2[0] > point1[0]
    && point2[1] < point1[1]) {
    candidateOneIsOnTheRight = candidateOne[1] > candidateTwo[1];
  }

  return getRightSide
    ? (candidateOneIsOnTheRight ? candidateOne : candidateTwo)
    : (candidateOneIsOnTheRight ? candidateTwo : candidateOne);
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

  const distanceBetweenNodes = calculatePointsDistance(startCoord, endCoord);
  let d = Math.max(Math.min(distanceFromStart / distanceBetweenNodes, 1), 0); // clamp this between 0 and 1 to prevent points outside of the segment
  if (!!options.graphicWidth && options.graphicWidth > distanceBetweenNodes) {
    d = 0.5;
  }
  const x = startCoord[0] + (endCoord[0] - startCoord[0]) * d;
  const y = startCoord[1] + (endCoord[1] - startCoord[1]) * d;
  return [x, y];
}

function getLineIntersect(line1Coords, line2Coords) {
  const x1 = line1Coords[0][0];
  const y1 = line1Coords[0][1];
  const x2 = line1Coords[1][0];
  const y2 = line1Coords[1][1];
  const x3 = line2Coords[0][0];
  const y3 = line2Coords[0][1];
  const x4 = line2Coords[1][0];
  const y4 = line2Coords[1][1];

  // https://en.wikipedia.org/wiki/Line%E2%80%93line_intersection#Given_two_points_on_each_line
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) -
    (x1 - x2) * (x3 * y4 - y3 * x4)) / denom;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) -
    (y1 - y2) * (x3 * y4 - y3 * x4)) / denom;

  return [
    px,
    py,
  ];
}
