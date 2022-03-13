import { containsCoordinate } from 'ol/extent';

// eslint-disable-next-line import/prefer-default-export
export function splitLineString(geometry, graphicSpacing, options) {
  function calculatePointsDistance(coord1, coord2) {
    const dx = coord1[0] - coord2[0];
    const dy = coord1[1] - coord2[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function calculateSplitPointCoords(
    startNode,
    nextNode,
    distanceBetweenNodes,
    distanceToSplitPoint
  ) {
    const d = distanceToSplitPoint / distanceBetweenNodes;
    const x = nextNode[0] + (startNode[0] - nextNode[0]) * d;
    const y = nextNode[1] + (startNode[1] - nextNode[1]) * d;
    return [x, y];
  }

  /**
   * Calculate the angle of a vector in radians clockwise from the north.
   * Example, north-pointing vector: (0,0) -> (0,1) --> 0 radians.
   * @param {Array<number>} p1 Start of the line segment as [x,y].
   * @param {Array<number>} p2 End of the line segment as [x,y].
   * @param {boolean} invertY If true, calculate with Y-axis pointing downwards.
   * @returns {number} Angle in radians, clockwise from the north.
   */
  function calculateAngle(p1, p2, invertY) {
    const dX = p2[0] - p1[0];
    const dY = p2[1] - p1[1];
    let angle = Math.PI / 2 - Math.atan2(invertY ? -dY : dY, dX);
    return angle;
  }

  const coords = geometry.getCoordinates();

  const splitPoints = [];
  let coordIndex = 0;
  let startPoint = coords[coordIndex];
  let nextPoint = coords[coordIndex + 1];
  let angle = calculateAngle(startPoint, nextPoint, options.invertY);

  const n = Math.ceil(geometry.getLength() / graphicSpacing);
  const segmentLength = geometry.getLength() / n;
  let currentSegmentLength = options.midPoints
    ? segmentLength / 2
    : segmentLength;

  for (let i = 0; i <= n; i += 1) {
    const distanceBetweenPoints = calculatePointsDistance(
      startPoint,
      nextPoint
    );
    currentSegmentLength += distanceBetweenPoints;

    if (currentSegmentLength < segmentLength) {
      coordIndex += 1;
      if (coordIndex < coords.length - 1) {
        startPoint = coords[coordIndex];
        nextPoint = coords[coordIndex + 1];
        angle = calculateAngle(startPoint, nextPoint, options.invertY);
        i -= 1;
        // continue;
      } else {
        if (!options.midPoints) {
          const splitPointCoords = nextPoint;
          if (
            !options.extent ||
            containsCoordinate(options.extent, splitPointCoords)
          ) {
            splitPointCoords.push(angle);
            splitPoints.push(splitPointCoords);
          }
        }
        break;
      }
    } else {
      const distanceToSplitPoint = currentSegmentLength - segmentLength;
      const splitPointCoords = calculateSplitPointCoords(
        startPoint,
        nextPoint,
        distanceBetweenPoints,
        distanceToSplitPoint
      );
      startPoint = splitPointCoords.slice();
      if (
        !options.extent ||
        containsCoordinate(options.extent, splitPointCoords)
      ) {
        splitPointCoords.push(angle);
        splitPoints.push(splitPointCoords);
      }
      currentSegmentLength = 0;
    }
  }

  return splitPoints;
}
