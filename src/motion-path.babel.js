import Tween from 'mojs-tween';

import ClassProto, { extendClass, createClass } from 'mojs-util-class-proto';
import separateTweenOptions from 'mojs-util-separate-tween-options';
import parseStaggerProperty from 'mojs-util-parse-stagger-property';

import { motionPathCache } from './motion-path-cache.babel.js';

/* ----------------------- */
/* The `MotionPath` class  */
/* ----------------------- */

// TODO:
//  - add bounds?
//  - add clone
//  - add global cache

const MotionPathClass = extendClass(ClassProto);
const Super = ClassProto.__mojsClass;

/* ---------------------- */
/* The `Public` functions */
/* ---------------------- */

/**
 * `update` - function to update the MotionPath.
 *
 * @public
 * @param {Number} Eased progress.
 * @param {Number} Progress.
 * @param {Boolean} If is forward direction.
 * @param {Object} This motion path.
 */
MotionPathClass.update = function (ep) {
  const { coordinate, property } = this._props;
  const { step } = this._samples;

  const index = (ep / step) | 0; // convert to integer
  const key = index * step; // get the key
  const nextKey = (index + 1) * step; // get the next key

  const diff = ep - key; // get error for the eased progress
  const value = this._samples.get(key)[coordinate]; // get the value

  let norm = value;
  // if next key is present, calculate the normalized value
  // regarding the eased progress error
  if (nextKey <= 1) {
    const nextItem = this._samples.get(nextKey);
    let nextValue = nextItem[coordinate];
    // for `angle` property need to add `a` property to mitigate
    // the case when two sibling items are close to each other,
    // but since angle has `360deg` period their delta could be large
    // e.g. (355deg vs 5deg) or (5deg vs -355deg)
    if (property === 'angle') { nextValue += nextItem.a; }

    norm = value + ((nextValue - value) * (diff / step));
  }

  if (this._unit === undefined) {
    this._target[property] = norm;
  } else {
    this._target[property] = `${norm}${this._unit}`;
  }

  return this;
};

/* ----------------------- */
/* The `Private` functions */
/* ----------------------- */

/**
 * `_samplePath` - function to sample path coordinates.
 *
 * @private
 * @param {Number} Number of floating point digits.
 */
MotionPathClass._samplePath = function (n = this._props.precision) {
  const { path, precision } = this._props;
  const cachedPath = motionPathCache.get(path, precision);
  // if we have the `path` with the `precision` cached - use it
  if (cachedPath) {
    this._samples = cachedPath;
  // if no cache - start over
  } else {
    this._samples = new Map();
    const totalLength = this._path.getTotalLength();
    const step = 1 / n;
    this._samples.step = step;
    this._samples.totalLength = totalLength;
    // samples the path, `key` is in range of [0..1]
    for (let i = 0; i < n; i++) {
      const key = i * step;
      this._setForKey(key);
      // for the first step only
      if (i === 1) {
        // the first step item
        const current = this._samples.get(key);
        // the zero (initial) item
        const zero = this._samples.get(0);
        // copy the angle of the first step to the zero item to prevent animation jumps
        this._samples.set(0, Object.assign({}, zero, { angle: current.angle }) );
      }
      // since we copy of the `1st` record to the `0s`, we can start from `2` here and look back
      if (i >= 2) {
        const currentRecord = this._samples.get(i * step);
        const currentAngle = currentRecord.angle;
        const prevAngle = this._samples.get((i - 1) * step).angle;
        // if values are on edge of `360degree` period, e.g. 355deg vs 5deg
        // add or substract `360` from the current item
        const isClose = (currentAngle - 180) * (prevAngle - 180) < 0;
        if (isClose && (Math.abs(currentAngle - prevAngle) > 180)) {
          if (currentAngle < prevAngle) {
            // add angle on the current record
            this._samples.set(i * step, Object.assign({}, currentRecord, { a: 360 }));
          } else {
            // remove angle on the current record
            this._samples.set(i * step, Object.assign({}, currentRecord, { a: -360 }));
          }
        }
      }
    }
    // the last sample is for `1`
    // the angle should be the same as for the `n-1` item
    this._setForKey(1);
    const nMinusOneRecord = this._samples.get((n - 1) * step);
    const lastRecord = this._samples.get(1);
    this._samples.set(1, Object.assign({}, lastRecord, { angle: nMinusOneRecord.angle }));
    // add generated hash map to the cache in case if the same path will be used again
    motionPathCache.save(path, precision, this._samples);
  }
};

/**
 * `_setForKey` - helper function for `_samplePath`,
 *                sets a key/value regarding `totalLength` on the map.
 *
 * @param  {Number} key Map key [0...1].
 */
MotionPathClass._setForKey = function (key) {
  const { totalLength } = this._samples;
  // x/y computation
  const length = key * totalLength;
  const point = this._path.getPointAtLength(length);
  const prevPoint = this._path.getPointAtLength(length - 1);
  // cangle computation
  const dX = (point.x - prevPoint.x) || 1;
  const dY = (point.y - prevPoint.y) || 1;
  let angle = (Math.atan(dY / dX) * (180 / Math.PI)) + 90;

  if (dX < 0) {
    angle = 180 + angle;
  }

  // set the point to the map
  this._samples.set(key, { x: point.x, y: point.y, angle, a: 0 });
};

/**
 * `init` - function init the class.
 *
 * @extends @ClassProto
 * @public
 */
MotionPathClass.init = function (o = {}) {
  // super call
  Super.init.call(this, o);
  // get target, if the `isSkipRender` is set on `property`
  // in `customProperties`, use `supportProps` otherwise use `el`
  const { el, supportProps, property, customProperties } = this._props;
  const custom = customProperties[property];
  this._target = (custom && custom.isSkipRender) ? supportProps : el;
  // if `unit` is defined or `type` is set on `customProperties`,
  // set the render `_unit` that will be added on render
  if (o.unit !== undefined || (custom && custom.type === 'unit')) {
    this._unit = o.unit || 'px';
  }
  // parse path
  this._parsePath();
  // precompute path
  this._samplePath();
  // set up tween
  this._setupTween();
};

/**
 * `_setupTween` - function set up tween if needed.
 *
 * @extends @ClassProto
 * @public
 */
MotionPathClass._setupTween = function () {
  // options
  const options = Object.assign({}, this._o);
  // separate tween  options
  const tweenOptions = separateTweenOptions(options);
  if (tweenOptions !== undefined) {
    const tweenProperties = Object.assign(
      {},
      tweenOptions, {
        // send `onUpdate` function to call the `this.update` function
        // and envoke previous `onUpdate`
        onUpdate: (ep, p, isForward) => {
          this.update(ep, p, isForward);
          // envoke old `onUpdate` if is present
          if (tweenOptions.onUpdate !== undefined) {
            tweenOptions.onUpdate(ep, p, isForward);
          }
        },
      }
    );

    this.tween = new Tween(tweenProperties);
  }
};

/**
 * `_decalreDefaults` - function to declare defaults.
 *
 * @extends @ClassProto
 * @private
 */
MotionPathClass._declareDefaults = function () {
  this._defaults = {
    el: null,
    supportProps: null,
    customProperties: {},
    path: 'M0,0 L100,100',
    precision: 140,
    coordinate: 'x',
    property: 'x',
  };
};

/**
 * _extendDefaults - Method to copy `_o` options to `_props` object
 *                  with fallback to `_defaults`.
 * @private
 * @overrides @ ClassProto
 */
MotionPathClass._extendDefaults = function () {
  // super call
  Super._extendDefaults.call(this);
  // parse stagger
  const propsKeys = Object.keys(this._props);
  for (let i = 0; i < propsKeys.length; i++) {
    const key = propsKeys[i];
    const prop = parseStaggerProperty(this._props[key], this.index, this._totalItemsInStagger);
    // check if path generator was passed to `path` property
    const isPathGenerator = (prop && typeof prop === 'object' && prop.path);
    this._props[key] = (isPathGenerator) ? prop.path : prop;
  }

  const { property } = this._props;
  if (property === 'y' || property === 'angle') {
    this.setIfNotSet('coordinate', property);
  }
};

/**
 * `_parsePath` - function to parse SVG motion path.
 */
MotionPathClass._parsePath = function () {
  const { path } = this._props;
  this._path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  this._path.setAttributeNS(null, 'd', path);
};

export const MotionPath = createClass(MotionPathClass);

export default MotionPath;
