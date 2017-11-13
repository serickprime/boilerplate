// ## Globals
let argv         = require('minimist')(process.argv.slice(2));
let autoprefixer = require('gulp-autoprefixer');
let browserSync  = require('browser-sync').create();
let changed      = require('gulp-changed');
let concat       = require('gulp-concat');
let flatten      = require('gulp-flatten');
let gulp         = require('gulp');
let gulpif       = require('gulp-if');
let imagemin     = require('gulp-imagemin');
let babel        = require('gulp-babel');
let lazypipe     = require('lazypipe');
let less         = require('gulp-less');
let merge        = require('merge-stream');
let cssNano      = require('gulp-cssnano');
let plumber      = require('gulp-plumber');
let rev          = require('gulp-rev');
let runSequence  = require('run-sequence');
let sass         = require('gulp-sass');
let sourcemaps   = require('gulp-sourcemaps');
let uglify       = require('gulp-uglify');
let eslint       = require('gulp-eslint');

// Подробнее: https://github.com/austinpray/asset-builder
let manifest = require('asset-builder')('./assets/manifest.json');

// `path` - Пути к статике
// - `path.source` - Путь к исходникам. По умолчанию: `assets/`
// - `path.dist` - Путь к собранной статике. По умолчанию: `dist/`
let path = manifest.paths;

// `config` - Здесь можно сохранить дополнительные настройки для использования в gulpfile
let config = manifest.config || {};

let globs = manifest.globs;
let project = manifest.getProjectGlobs();

// Опции для командной строки
let enabled = {
  // Добавить хэши к статике для борьбы с кэшированием старых версий `--production`
  rev: argv.production,
  // Отключить source-maps `--production`
  maps: !argv.production,
  // Прервать процесс сборки при ошибке сборки стилей `--production`
  failStyleTask: argv.production,
  // Прервать процесс сборки при получении предупреждений JSHint `--production`
  failESlint: argv.production,
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
    server: '.',
    ghostMode: false,
    open: true,
    cors: true
  };
}

// Путь к манифесту собранной статики (для получения актуальных имён файлов с хэшами)
let revManifest = path.dist + 'assets.json';

// Обработка ошибок - выдавать лог ошибки вместо падений процесса сборки
let onError = function(err) {
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
let cssTasks = function(filename) {
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
let jsTasks = function(filename) {
  return lazypipe()
    .pipe(function() {
      return gulpif(enabled.maps, sourcemaps.init());
    })
    .pipe(babel)
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
let writeToManifest = function(directory) {
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
  let merged = merge();
  manifest.forEachDependency('css', function(dep) {
    let cssTasksInstance = cssTasks(dep.name);
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
gulp.task('scripts', ['eslint'], function() {
  let merged = merge();
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

// ### ESLint
// `gulp eslint` - Линтинг JS и JSON файлов
gulp.task('eslint', function() {
  return gulp.src(project.js)
    .pipe(eslint())
    .pipe(eslint.format())
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
  gulp.watch([path.source + 'scripts/**/*'], ['eslint', 'scripts']);
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
  let wiredep = require('wiredep').stream;
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
