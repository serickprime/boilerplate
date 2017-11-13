// ## Globals
var argv         = require('minimist')(process.argv.slice(2));
var autoprefixer = require('gulp-autoprefixer');
var browserSync  = require('browser-sync').create();
var changed      = require('gulp-changed');
var concat       = require('gulp-concat');
var flatten      = require('gulp-flatten');
var gulp         = require('gulp');
var gulpif       = require('gulp-if');
var imagemin     = require('gulp-imagemin');
var jshint       = require('gulp-jshint');
var lazypipe     = require('lazypipe');
var less         = require('gulp-less');
var merge        = require('merge-stream');
var cssNano      = require('gulp-cssnano');
var plumber      = require('gulp-plumber');
var rev          = require('gulp-rev');
var runSequence  = require('run-sequence');
var sass         = require('gulp-sass');
var sourcemaps   = require('gulp-sourcemaps');
var uglify       = require('gulp-uglify');

// Подробнее: https://github.com/austinpray/asset-builder
var manifest = require('asset-builder')('./assets/manifest.json');

// `path` - Пути к статике
// - `path.source` - Путь к исходникам. По умолчанию: `assets/`
// - `path.dist` - Путь к собранной статике. По умолчанию: `dist/`
var path = manifest.paths;

// `config` - Здесь можно сохранить дополнительные настройки для использования в gulpfile
var config = manifest.config || {};

var globs = manifest.globs;
var project = manifest.getProjectGlobs();

// Опции для командной строки
var enabled = {
  // Добавить хэши к статике для борьбы с кэшированием старых версий `--production`
  rev: argv.production,
  // Отключить source-maps `--production`
  maps: !argv.production,
  // Прервать процесс сборки при ошибке сборки стилей `--production`
  failStyleTask: argv.production,
  // Прервать процесс сборки при получении предупреждений JSHint `--production`
  failJSHint: argv.production,
  // Убрать debug-опции из js `--production`
  stripJSDebug: argv.production
};

// Опции для BrowserSync
if ( config.useProxy ) {
  // стандартные настройки Sage для работы с фронтендом поверх работающего сервера
  config.BSOptions = {
    files: ['{lib,templates}/**/*.php', '*.php'],
    proxy: config.devUrl
  };
} else {
  // использовать для разработки dev-сервер BrowserSync
  config.BSOptions = {
    server: ".",
    ghostMode: false,
    open: true,
    cors: true
  };
}

// Путь к манифесту собранной статики (для получения актуальных имён файлов с хэшами)
var revManifest = path.dist + 'assets.json';

// Обработка ошибок - выдавать лог ошибки вместо падений процесса сборки
var onError = function(err) {
  console.log(err.toString());
  this.emit('end');
};

// ## Повторяемые пайплайны/процессы
// Подробнее: https://github.com/OverZealous/lazypipe

// ### Процесс обработки CSS
// Пример:
// ```
// gulp.src(cssFiles)
//   .pipe(cssTasks('main.css')
//   .pipe(gulp.dest(path.dist + 'styles'))
// ```
var cssTasks = function(filename) {
  return lazypipe()
    .pipe(function() {
      return gulpif(!enabled.failStyleTask, plumber());
    })
    .pipe(function() {
      return gulpif(enabled.maps, sourcemaps.init());
    })
    .pipe(function() {
      return gulpif('*.less', less());
    })
    .pipe(function() {
      return gulpif('*.scss', sass({
        outputStyle: 'nested', // libsass не поддерживает expanded-версии
        precision: 10,
        includePaths: ['.'],
        errLogToConsole: !enabled.failStyleTask
      }));
    })
    .pipe(concat, filename)
    .pipe(autoprefixer, { // браузеры для автопрефиксера
      browsers: [
        'last 2 versions',
        'android 4',
        'opera 12'
      ]
    })
    .pipe(cssNano, {
      safe: true
    })
    .pipe(function() {
      return gulpif(enabled.rev, rev());
    })
    .pipe(function() {
      return gulpif(enabled.maps, sourcemaps.write('.', {
        sourceRoot: 'assets/styles/'
      }));
    })();
};

// ### Процесс обработки JS
// Пример:
// ```
// gulp.src(jsFiles)
//   .pipe(jsTasks('main.js')
//   .pipe(gulp.dest(path.dist + 'scripts'))
// ```
var jsTasks = function(filename) {
  return lazypipe()
    .pipe(function() {
      return gulpif(enabled.maps, sourcemaps.init());
    })
    .pipe(concat, filename)
    .pipe(uglify, {
      compress: {
        'drop_debugger': enabled.stripJSDebug
      }
    })
    .pipe(function() {
      return gulpif(enabled.rev, rev());
    })
    .pipe(function() {
      return gulpif(enabled.maps, sourcemaps.write('.', {
        sourceRoot: 'assets/scripts/'
      }));
    })();
};

// ### Процесс записи ревизий статики с хэшами в манифест
// Подробнее: https://github.com/sindresorhus/gulp-rev
var writeToManifest = function(directory) {
  return lazypipe()
    .pipe(gulp.dest, path.dist + directory)
    .pipe(browserSync.stream, {match: '**/*.{js,css}'})
    .pipe(rev.manifest, revManifest, {
      base: path.dist,
      merge: true
    })
    .pipe(gulp.dest, path.dist)();
};

// ## Задачи для Gulp
// Run `gulp -T` for a task summary

// ### Стили
// `gulp styles` - Компилирует, объединяет и оптимизирует CSS проекта и зависимостей Bower
gulp.task('styles', ['wiredep'], function() {
  var merged = merge();
  manifest.forEachDependency('css', function(dep) {
    var cssTasksInstance = cssTasks(dep.name);
    if (!enabled.failStyleTask) {
      cssTasksInstance.on('error', function(err) {
        console.error(err.message);
        this.emit('end');
      });
    }
    merged.add(gulp.src(dep.globs, {base: 'styles'})
      .pipe(plumber({errorHandler: onError}))
      .pipe(cssTasksInstance));
  });
  return merged
    .pipe(writeToManifest('styles'));
});

// ### JS
// `gulp scripts` - Компилирует, объединяет и оптимизирует JS проекта и зависимостей Bower
gulp.task('scripts', ['jshint'], function() {
  var merged = merge();
  manifest.forEachDependency('js', function(dep) {
    merged.add(
      gulp.src(dep.globs, {base: 'scripts'})
        .pipe(plumber({errorHandler: onError}))
        .pipe(jsTasks(dep.name))
    );
  });
  return merged
    .pipe(writeToManifest('scripts'));
});

// ### Шрифты
// `gulp fonts` - Берёт все шрифты и помещает плоской структурой (без вложенности папок) в папку со статикой
// Подробнее: https://github.com/armed/gulp-flatten
gulp.task('fonts', function() {
  return gulp.src(globs.fonts)
    .pipe(flatten())
    .pipe(gulp.dest(path.dist + 'fonts'))
    .pipe(browserSync.stream());
});

// ### Изображения
// `gulp images` - Запускает оптимизацию изображений без потерь
gulp.task('images', function() {
  return gulp.src(globs.images)
    .pipe(imagemin([
      imagemin.jpegtran({progressive: true}),
      imagemin.gifsicle({interlaced: true}),
      imagemin.svgo({plugins: [
        {removeUnknownsAndDefaults: false},
        {cleanupIDs: false}
      ]})
    ]))
    .pipe(gulp.dest(path.dist + 'images'))
    .pipe(browserSync.stream());
});

// ### JSHint
// `gulp jshint` - Линтинг JS и JSON файлов
gulp.task('jshint', function() {
  return gulp.src([
    'bower.json', 'gulpfile.js'
  ].concat(project.js))
    .pipe(jshint())
    .pipe(jshint.reporter('jshint-stylish'))
    .pipe(gulpif(enabled.failJSHint, jshint.reporter('fail')));
});

// ### Чистка
// `gulp clean` - Удаляет папку со статикой перед сборкой новых файлов
gulp.task('clean', require('del').bind(null, [path.dist]));

// ### Watch-процессы
// `gulp watch` - запускает BrowserSync и следит за изменением файлов,
// после чего запускает соответствующие процессы сборки.
// Подробнее: http://www.browsersync.io
gulp.task('watch', function() {
  browserSync.init(config.BSOptions);
  gulp.watch([path.source + 'styles/**/*'], ['styles']);
  gulp.watch([path.source + 'scripts/**/*'], ['jshint', 'scripts']);
  gulp.watch([path.source + 'fonts/**/*'], ['fonts']);
  gulp.watch([path.source + 'images/**/*'], ['images']);
  gulp.watch(['bower.json', 'assets/manifest.json'], ['build']);
  gulp.watch(['*.html','*.php']).on('change', browserSync.reload);
});

// ### Build
// `gulp build` - Запускает все процессы сборки, используется общим
// процессом Gulp после очистки папки со статикой
gulp.task('build', function(callback) {
  runSequence('styles',
    'scripts',
    ['fonts', 'images'],
    callback);
});

// ### Wiredep
// `gulp wiredep` - Автоматически добавляет зависимости Bower в CSS и JS
// https://github.com/taptapship/wiredep
gulp.task('wiredep', function() {
  var wiredep = require('wiredep').stream;
  return gulp.src(project.css)
    .pipe(wiredep())
    .pipe(changed(path.source + 'styles', {
      hasChanged: changed.compareSha1Digest
    }))
    .pipe(gulp.dest(path.source + 'styles'));
});

// ### Gulp
// `gulp` - Запустить процесс сборки. Для production-версии без sourcemap и хэшей: gulp --production
gulp.task('default', ['clean'], function() {
  gulp.start('build');
});
