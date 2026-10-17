# Установка Scopos в ваш продукт

Scopos ставится одним из трёх способов. Каждый занимает минуту-две:

| Способ | Подходит для | Что добавить |
|---|---|---|
| [1. Тег `<script>`](#1-тег-script) | любой сайт, CMS, серверный рендеринг | одну строку в HTML |
| [2. React](#2-react) | React, Next.js, Remix | `npm i @scopos/react`, `<ScoposProvider>` |
| [3. Обычный JS](#3-обычный-js) | Vue, Svelte, Angular, без фреймворка | `npm i @scopos/js`, `init()` |

Всем трём нужен [бэкенд](#0-бэкенд-сервер-scopos): он хранит ключ Claude. В браузер ключ не попадает никогда. У Frigade в браузере лежит публичный `apiKey`, а у Scopos в браузере ключа нет совсем.

**Что получит ваш пользователь.** Сначала страница грузит загрузчик `scopos.js`: 2,3 КБ в gzip. Он рисует кнопку «Спросить» и больше ничего не делает. Ядро весит 44,5 КБ в gzip. Оно подгружается, когда браузер простаивает, или при первом наведении на кнопку. Если на странице идёт гайд, ядро грузится сразу. Код режима изучения весит 29 КБ, и обычные пользователи его не скачивают. Имена файлов ядра содержат хэш содержимого, поэтому браузер и CDN кэшируют их навсегда.

---

## 0. Бэкенд: сервер Scopos

Виджет обращается к вашему же домену:

| Запрос | Что делает |
|---|---|
| `POST /api/scopos` | вопрос → шаги (через Claude, с кэшем) |
| `GET /api/scopos/knowledge` | готовые гайды по продукту |
| `POST /api/scopos/learn` | режим изучения (только localhost или с токеном) |
| `GET /scopos.js`, `/scopos-core.<hash>.js`, `/scopos-learn.<hash>.js` | сам SDK |

Всё это отдаёт сервер Scopos (`server/server.mjs`, Node 20, без зависимостей).

**Запуск одной командой (Docker).** Подробности в [deploy/README.md](../deploy/README.md):

```bash
cp deploy/.env.example deploy/.env      # ANTHROPIC_API_KEY, SCOPOS_ORIGINS=https://app.example.com
docker compose -f deploy/docker-compose.yml up -d --build
```

**Без Docker:**

```bash
npm ci && npm run build                  # dist/: загрузчик + ядро
ANTHROPIC_API_KEY=sk-ant-... SCOPOS_ORIGINS=https://app.example.com node server/server.mjs
```

**Один домен с приложением.** Сервер Scopos не отдаёт CORS-заголовки, поэтому `/api/scopos` должен быть на том же origin, что и ваше приложение. Проще всего завести маршрут-прокси на ваш сервер Scopos.

nginx:

```nginx
location /api/scopos { proxy_pass http://127.0.0.1:4173; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_buffering off; }
location ~ ^/scopos(-core|-learn)?(\.[0-9a-f]+)?\.js$ { proxy_pass http://127.0.0.1:4173; proxy_set_header Host $host; }
```

Next.js (`next.config.js`):

```js
module.exports = {
  async rewrites() {
    return [
      { source: '/api/scopos/:path*', destination: 'http://scopos:4173/api/scopos/:path*' },
      { source: '/api/scopos', destination: 'http://scopos:4173/api/scopos' },
      { source: '/:file(scopos\\.js|scopos-core\\.\\w+\\.js|scopos-learn\\.\\w+\\.js)', destination: 'http://scopos:4173/:file' },
    ];
  },
};
```

Если прокси подставляет свой `Host` (так делают rewrites в Next.js: `Host: scopos:4173`), добавьте его в `SCOPOS_HOSTS=scopos:4173`. Домен приложения в любом случае укажите в `SCOPOS_ORIGINS`.

`proxy_buffering off` нужен, чтобы ответ Claude приходил потоком: виджет показывает прогресс по мере генерации.

Файлы SDK можно раздавать и с CDN: загрузчик сам находит ядро рядом с собой. Тогда кэшируйте `scopos.js` коротко (`no-cache` или пару минут), а `scopos-*.<hash>.js` навсегда (`immutable`). Сервер Scopos ставит эти заголовки сам.

---

## 1. Тег `<script>`

Вставьте перед `</body>`:

```html
<script src="/scopos.js"
        data-endpoint="/api/scopos"
        data-product="Ledgerly, счета и платежи"
        async></script>
```

После перезагрузки страницы в правом нижнем углу появится кнопка «Спросить».

Вызовы из вашего кода работают сразу, даже до загрузки ядра: они встанут в очередь и выполнятся, когда ядро подгрузится.

```js
Scopos.widget.open();
Scopos.widget.ask('Как выставить счёт?');
Scopos.widget.startGuide('Выставить счёт клиенту');   // по имени или id; вернёт Promise<boolean>
```

### Атрибуты

| Атрибут | По умолчанию | Что делает |
|---|---|---|
| `data-endpoint` | `/api/scopos` | маршрут к серверу Scopos на вашем домене |
| `data-product` | — | название продукта и пара слов о нём |
| `data-label` | `Спросить` | текст кнопки |
| `data-playbooks` | — | URL JSON со сценариями, записанными расширением |
| `data-load` | `idle` | `idle`: ядро грузится, когда браузер простаивает; `click`: только при первом использовании (минимум для слабых машин); `eager`: сразу |
| `data-learn` | выкл. | разрешить режим изучения (см. [безопасность](#безопасность)) |
| `data-learn-token` | — | токен изучения для staging |

Если у вас строгая CSP с `nonce`, поставьте `nonce` на тег: загрузчик передаст его ядру. В CSP нужен `script-src` для источника `scopos.js` и `connect-src 'self'`.

---

## 2. React

```bash
npm i @scopos/react
```

Пока пакет не опубликован, ставьте его из репозитория: `npm i ./path/to/ScoposWeb/packages/react`.

```tsx
import { ScoposProvider, useScopos } from '@scopos/react';

export default function App() {
  return (
    <ScoposProvider endpoint="/api/scopos" product="Ledgerly, счета и платежи">
      <Routes />
    </ScoposProvider>
  );
}

function InvoiceHelp() {
  const scopos = useScopos();
  return <button onClick={() => scopos.startGuide('Выставить счёт клиенту')}>Покажите, как</button>;
}
```

Как устроен провайдер:

- **Загрузка.** Провайдер один раз добавляет загрузчик на страницу и ничего не рендерит сам. Кнопка Scopos живёт в своём shadow root вне React-дерева, поэтому её не задевают переходы между страницами и перерисовки.
- **Хук.** `useScopos()` возвращает `{ open(), ask(question), startGuide(nameOrId) }`. Вызовы до загрузки ядра ждут его. Хук работает и без провайдера, если Scopos уже подключён тегом.
- **Пропсы:**
  - `endpoint`, `product`, `label`, `playbooks`, `load`, `learn`, `learnToken`, `nonce`: значат то же, что атрибуты тега;
  - `src`: адрес загрузчика, по умолчанию `/scopos.js`.
- **Поддержка.** Типы TypeScript входят в пакет. Next.js App Router поддерживается: в пакете уже стоит `'use client'`, а провайдер можно положить в `app/layout.tsx`.
- **Зависимости.** Пакет не тянет ничего, кроме `react` (peer).

---

## 3. Обычный JS

```bash
npm i @scopos/js            # пока не опубликован: npm i ./path/to/ScoposWeb/packages/js
```

```js
import { init } from '@scopos/js';

const scopos = init({ endpoint: '/api/scopos', product: 'Ledgerly, счета и платежи' });

document.querySelector('#help').addEventListener('click', () => scopos.ask('Как пригласить коллегу?'));
```

Повторный `init()` возвращает того же клиента: на странице всегда один Scopos. Опции те же, что у React-провайдера.

---

## Безопасность

- **Ключ Claude только на сервере.** Передавайте его через `ANTHROPIC_API_KEY` в окружение сервера Scopos. Не кладите ключ в фронтенд, в `NEXT_PUBLIC_*` или в атрибуты тега. Браузер обращается только к `/api/scopos`, а сервер добавляет ключ сам.
- **Лимиты расходов.**
  - `SCOPOS_MONTHLY_USD` (по умолчанию $5): потолок расходов в месяц. Когда он достигнут, все вызовы Claude останавливаются.
  - `SCOPOS_DAILY_LIMIT`: общий дневной лимит вызовов.
  - Отдельно действует лимит в 12 вызовов в минуту с одного IP. Если перед сервером стоит ваш прокси, включите `SCOPOS_TRUST_PROXY=1`, чтобы лимит считался по реальному адресу клиента.
- **Чужие сайты.** Сервер принимает запросы только со своих хостов и из `SCOPOS_ORIGINS`. Запросы с других сайтов и через подменённый DNS получают 403.
- **`data-learn` не для продакшена.**
  - В режиме изучения Scopos сам ходит по продукту и нажимает кнопки под текущим аккаунтом. Запись при этом блокируется, но включайте режим только на localhost или staging.
  - На `localhost` достаточно `data-learn` и `?scopos-learn=1` в адресе.
  - На staging задайте на сервере `SCOPOS_LEARN_TOKEN`, а на странице `data-learn-token`. Токен не должен попасть в продакшен-сборку: без него сервер отклонит `/api/scopos/learn`.
  - Можно и иначе: изучите продукт локально и положите готовый файл знаний на продакшен-сервер (см. [deploy/README.md](../deploy/README.md)).
- **Админка закрыта снаружи.** `/setup`, `/api/key` и `/api/scopos/stats` работают только с той же машины, где запущен сервер, и только без прокси. В Docker они снаружи недоступны.
