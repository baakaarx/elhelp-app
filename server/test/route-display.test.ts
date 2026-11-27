import test from 'node:test';
import assert from 'node:assert/strict';
import { displayRoute, routeSegments } from '../../dashboard/src/routeDisplay.js';
import type { RouteResponse } from '../../dashboard/src/types.js';

type Fix = RouteResponse['points'][number];
const fix = (id: string, latOffset: number, at: number, accuracy: number | null = 25, shiftId = 'shift'): Fix => ({
  id, shiftId, lat: 31.2 + latOffset / 111195, lng: 29.9, accuracy, speed: null, heading: null, battery: null, recordedAt: at, receivedAt: at, source: 'gps',
});

test('stationary GPS drift is not drawn as a route; raw readings are still available unchanged', () => {
 const points = [fix('a', 0, 0), fix('b', 18, 30000), fix('c', -20, 60000), fix('d', 15, 90000)];
 assert.deepEqual(displayRoute(points).map(p => p.id), ['a']);
 assert.deepEqual(displayRoute(points, true).map(p => p.id), ['a', 'b', 'c', 'd']);
 assert.equal(points[3].lat, fix('d', 15, 90000).lat);
});

test('movement exceeding uncertainty is retained, including gradual movement', () => {
 const points = [fix('a', 0, 0, 10), fix('b', 12, 30000, 10), fix('c', 30, 60000, 10), fix('d', 60, 90000, 10)];
 assert.deepEqual(displayRoute(points).map(p => p.id), ['a', 'c', 'd']);
});

test('weak signal, long gaps and shifts break the line; unknown accuracy is not silently filtered', () => {
 const points = [fix('a',0,0,10),fix('weak',200,30000,150),fix('b',300,60000,10),fix('gap',400,720000,10),fix('shift',500,750000,10,'new'),fix('unknown',510,780000,null,'new')];
 const clean = displayRoute(points);
 assert.deepEqual(routeSegments(clean).map(s => s.map(p => p.id)), [['a'],['b'],['gap'],['shift','unknown']]);
 assert.deepEqual(routeSegments(displayRoute(points, true)).map(s => s.map(p => p.id)), [['a','weak','b'],['gap'],['shift','unknown']]);
});
