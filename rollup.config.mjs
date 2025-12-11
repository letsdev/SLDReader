// import buble from '@rollup/plugin-buble';
// import { nodeResolve } from '@rollup/plugin-node-resolve';
//
// export default {
//   input: 'src/index.js',
//   external: moduleId => moduleId.indexOf('ol') === 0,
//   output: {
//     file: 'dist/sldreader.js',
//     format: 'umd',
//     name: 'SLDReader',
//     globals: {
//       'ol/style': 'ol.style',
//       'ol/render': 'ol.render',
//       'ol/extent': 'ol.extent',
//       'ol/geom': 'ol.geom',
//       'ol/has': 'ol.has',
//     },
//   },
//   plugins: [
//     buble({
//       objectAssign: true,
//       transforms: {
//         asyncAwait: false,
//         forOf: false, // Disable for...of transformation
//         dangerousForOf: false, // Disable dangerous for...of transformation
//         modules: false, // Keep ES6 modules
//       },
//     }),
//     nodeResolve(),
//   ],
// };



import babel from '@rollup/plugin-babel';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'src/index.js',
  external: moduleId => moduleId.indexOf('ol') === 0,
  output: {
    file: 'dist/sldreader.js',
    format: 'umd',
    name: 'SLDReader',
    globals: {
      'ol/style': 'ol.style',
      'ol/render': 'ol.render',
      'ol/extent': 'ol.extent',
      'ol/geom': 'ol.geom',
      'ol/has': 'ol.has',
    },
  },
  plugins: [
    babel({
      babelHelpers: 'bundled',
      // Keep output close to source for readability: modern target, avoid generator transforms.
      presets: [
        [
          '@babel/preset-env',
          {
            targets: { esmodules: true },
            bugfixes: true,
            modules: false,
            exclude: [
              'transform-async-to-generator',
              'transform-regenerator',
            ],
          },
        ],
      ],
    }),
    nodeResolve()
  ],
};
