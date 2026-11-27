/**
 * Быстрая проверка собранного dist/ без запуска сервера.
 * Запуск: npm run smoke (после npm run build)
 */
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const failures = [];

const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${message}`);
};

if (!fs.existsSync(dist)) {
  console.error('dist/ отсутствует — сначала выполните npm run build');
  process.exit(1);
}

const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
check(indexHtml.includes('manifest.webmanifest'), 'index.html ссылается на манифест');
check(indexHtml.includes('registerSW.js'), 'index.html подключает service worker');
check(/<div id="app">/.test(indexHtml), 'index.html содержит точку монтирования #app');

const assetsDir = path.join(dist, 'assets');
const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
const jsFiles = assets.filter((f) => f.endsWith('.js'));
const cssFiles = assets.filter((f) => f.endsWith('.css'));
check(jsFiles.length > 0, 'собран JS-бандл');
check(cssFiles.length > 0, 'собран CSS-бандл');

const js = jsFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
check(js.includes('Наставник'), 'в бандле есть строки интерфейса');
check(js.includes('deepseek'), 'в бандле есть клиент DeepSeek');
check(js.includes('api.deepseek.com'), 'в бандле есть прямой адрес DeepSeek API');
check(js.includes('Синхронизация'), 'в бандле есть раздел синхронизации');
check(js.includes('Нажмите на название'), 'в бандле есть подсказка о раскрытии конспектов');
check(js.includes('Конспект пункта'), 'в бандле есть читалка конспекта задания');
check(js.includes('Нажмите на задание, чтобы открыть конспект'), 'в бандле есть подсказка о конспекте по клику на задание');
check(js.includes('Помощник календаря и дел'), 'в бандле есть помощник календаря и дел');
check(js.includes('planner_actions'), 'в бандле есть инструмент помощника');
check(js.includes('Загрузить копию «Ассистента»'), 'в бандле есть импорт календаря из «Ассистента»');
check(js.includes('Все дела'), 'в бандле есть страница дел с повтором');
check(js.includes('task.create'), 'в бандле есть действия помощника с делами');

const firebaseFiles = jsFiles.filter((f) =>
  fs.readFileSync(path.join(assetsDir, f), 'utf8').includes('firestore.googleapis.com')
);
check(firebaseFiles.length > 0, 'Firebase собран отдельным чанком');
const firebaseJs = firebaseFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
check(!firebaseJs.includes('appToken'), 'в чанках Firebase нет токена приложения');

const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8'));
check(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'манифест описывает иконки');
check(manifest.display === 'standalone', 'манифест: display=standalone');

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
for (const icon of manifest.icons) {
  const p = path.join(dist, icon.src);
  const exists = fs.existsSync(p);
  check(exists, `файл иконки на месте: ${icon.src}`);
  if (exists) {
    const head = fs.readFileSync(p).subarray(0, 4);
    check(head.equals(pngSignature), `иконка является PNG: ${icon.src}`);
  }
}

const swPath = path.join(dist, 'sw.js');
check(fs.existsSync(swPath), 'сгенерирован service worker');
if (fs.existsSync(swPath)) {
  const sw = fs.readFileSync(swPath, 'utf8');
  check(sw.includes('precache'), 'service worker содержит precache');
}

if (failures.length > 0) {
  console.error(`\nПровалено проверок: ${failures.length}`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');
