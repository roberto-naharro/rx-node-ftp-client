const gulp = require('gulp');
const ts = require('gulp-typescript');
const debug = require('gulp-debug');
const path = require('upath');
const sourcemaps = require('gulp-sourcemaps');
const del = require('del');
const filter = require('gulp-filter');
const dts_gen = require('dts-generator').default;

const tsProject = ts.createProject('tsconfig.json');
const packageName = 'rx-node-ftp-client';

gulp.task('build-types', function() {
  return dts_gen({
    name: packageName,
    baseDir: 'lib/',
    project: './',
    out: 'index.d.ts',
    exclude: ['test/**/*', 'node_modules/**/*.d.ts'],
    resolveModuleId: () => packageName,
    types: ['rxjs', 'node'],
  });
});

gulp.task('clean', function() {
  return del([
    'lib/client.js',
    'index.d.ts',
    'test/*.js',
  ]);
});

gulp.task('build', function() {
  const tsResult = tsProject.src()
    .pipe(filter(['**', '!**/*.test.ts']))
    .pipe(tsProject());

  return tsResult.js
    .pipe(gulp.dest('.'));
});

gulp.task('build-test', gulp.series(['clean'], function compileTest() {
  const tsResult = tsProject.src()
    .pipe(sourcemaps.init())
    .pipe(tsProject());

  return tsResult.js
    .pipe(sourcemaps.write({
      sourceRoot: function(file) {
        return path.relative(path.dirname(file.path), file.base);
      }
    }))
    .pipe(gulp.dest('.'));
}));

gulp.task('default', gulp.series(['clean', 'build', 'build-types']));
