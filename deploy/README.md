# Сервер Scopos в Docker

Одна команда поднимает всё, что нужно вашему продукту от Scopos:

- прокси к Claude с вашим ключом;
- хранилище знаний о продукте;
- файлы SDK (`/scopos.js` и ядро).

Как подключить виджет на фронтенде, описано в [docs/install.md](../docs/install.md).

## Запуск

Команды выполняются из корня репозитория:

```bash
cp deploy/.env.example deploy/.env       # впишите ANTHROPIC_API_KEY и SCOPOS_ORIGINS
docker compose -f deploy/docker-compose.yml up -d --build
curl -I http://localhost:4173/scopos.js  # 200
```

Docker сам собирает SDK внутри образа (esbuild, минификация), поэтому собирать его заранее не нужно.

## Переменные (`deploy/.env`)

| Переменная | Обязательна | Что значит |
|---|---|---|
| `ANTHROPIC_API_KEY` | да | ключ Claude. Хранится только на сервере, в браузер не уходит |
| `SCOPOS_ORIGINS` | да, для продакшена | origin'ы вашего приложения через запятую, например `https://app.example.com`. С других сайтов запросы получают 403 |
| `SCOPOS_MONTHLY_USD` | нет, по умолчанию `5` | потолок расходов на Claude в месяц, в долларах. Когда он достигнут, вызовы останавливаются |
| `PORT` | нет, по умолчанию `4173` | порт внутри контейнера и на хосте |
| `SCOPOS_TRUST_PROXY` | нет, по умолчанию `0` | `1`, если перед контейнером стоит ваш nginx, Caddy или балансировщик. Тогда лимит в 12 запросов в минуту считается по реальному IP клиента из `X-Forwarded-For` |
| `SCOPOS_LEARN_TOKEN` | нет | разрешает режим изучения через сеть с заголовком `x-scopos-learn-token`. Нужен только на staging |
| `SCOPOS_HOSTS` | нет | дополнительные значения `Host`, если прокси подставляет свой, например `scopos:4173` |
| `SCOPOS_DAILY_LIMIT` | нет, по умолчанию `2000` | вызовов Claude в день на всех |

## Данные

Всё состояние хранится в томе `scopos-data`, смонтированном в `/data`:

| Файл | Что внутри |
|---|---|
| `knowledge.json` | карта продукта и готовые гайды, которые написал режим изучения |
| `answers.json` | кэш ответов: повторный вопрос не тратит токены |
| `usage.json` | расходы по месяцам, по ним работает `SCOPOS_MONTHLY_USD` |
| `key` | необязательно: ключ Claude файлом вместо переменной |

Чтобы перенести знания, изученные локально через `localhost:4173` и `?scopos-learn=1`, скопируйте файл в том:

```bash
# том называется <проект>_scopos-data, по умолчанию deploy_scopos-data (см. docker volume ls)
docker run --rm -v deploy_scopos-data:/data -v "$PWD":/src:ro alpine \
  sh -c 'cp /src/.scopos-knowledge.local.json /data/knowledge.json && chown 1000:1000 /data/knowledge.json'
docker compose -f deploy/docker-compose.yml restart
```

## Подключение к приложению

Виджет обращается к `/api/scopos` на домене приложения, а CORS сервер не отдаёт. Поэтому поставьте маршрут-прокси на вашем веб-сервере. По умолчанию контейнер слушает только `127.0.0.1:4173` хоста.

```nginx
location /api/scopos { proxy_pass http://127.0.0.1:4173; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_buffering off; }
location ~ ^/scopos(-core|-learn)?(\.[0-9a-f]+)?\.js$ { proxy_pass http://127.0.0.1:4173; proxy_set_header Host $host; }
```

В этом случае задайте `SCOPOS_ORIGINS=https://app.example.com` и `SCOPOS_TRUST_PROXY=1`.

Если открывать контейнер в сеть напрямую, в `docker-compose.yml` замените `"127.0.0.1:${PORT}:${PORT}"` на `"${PORT}:${PORT}"`.

## Что внутри образа

- **Образ.** `node:20-alpine`, процесс запускается от пользователя `node`, корневая файловая система только для чтения, запись идёт только в `/data`.
- **Файлы.** В образ попадают только:
  - `server/`;
  - `extension/core/brain.js`;
  - `sdk/build.mjs`, чтобы раздавать собранный `dist/`;
  - `dist/`;
  - `deploy/edge.mjs`.

  Демо-приложение по умолчанию не включено. Для первой пробы раскомментируйте `COPY demo/` в `Dockerfile`.
- **Почему нужен `edge.mjs`.** `server.mjs` слушает только loopback, а из контейнера loopback недоступен. `edge.mjs` запускает сервер и пробрасывает к нему запросы с внешнего адреса контейнера на тот же порт. Каждый проброшенный запрос помечается заголовком `X-Forwarded-For`, поэтому админские маршруты (`/setup`, `/api/key`, `/api/scopos/stats`) снаружи всегда закрыты. Ключ задаётся только через переменную или файл в томе.
- **Healthcheck.** Проверяет, что `GET /scopos.js` отвечает 200.
- **Секреты.** `.scopos-*`, `.git` и `node_modules` в контекст сборки не попадают (`Dockerfile.dockerignore`).

## Обновление

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

Знания, кэш и расходы хранятся в томе и переживают пересборку. Ядро SDK после обновления получает новое имя с хэшем, поэтому пользователи не застрянут на старой версии из кэша.
