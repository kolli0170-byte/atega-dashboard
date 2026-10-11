---
name: marketplace-api
description: Справочник API Wildberries, Ozon, Ozon Performance, amoCRM, Битрикс24, Т-Банк Бизнес, Точка, Диадок и Telegram Bot API — адреса, авторизация, лимиты и поля, которые использует BrandOS. Используй при работе с коннекторами, при ошибках 401/403/429 от этих сервисов и при вопросах «где взять токен».
---

# Справочник API для BrandOS

Это рабочие заметки, по которым написаны коннекторы BrandOS. API меняются: перед изменением коннектора сверяйся с официальной документацией по ссылке в каждом разделе. Если поле в ответе называется иначе, чем здесь, верь документации и обнови этот файл.

## Wildberries — https://dev.wildberries.ru

- **Авторизация:** заголовок `Authorization: <токен>` (без Bearer). Токен: ЛК → Профиль → Настройки → Доступ к API. У токена отмечаются категории: Статистика, Аналитика, Документы, Продвижение. Для дашборда — только чтение.
- **Статистика** `https://statistics-api.wildberries.ru`. Лимит — около 1 запроса в минуту на метод.
  - `GET /api/v1/supplier/sales?dateFrom=YYYY-MM-DD` — продажи и возвраты. `saleID` на `S` — продажа, на `R` — возврат. Поля: `date`, `supplierArticle`, `nmId`, `priceWithDisc`, `finishedPrice`, `forPay` (к выплате).
  - `GET /api/v1/supplier/orders?dateFrom=…` — заказы, `isCancel`.
  - `GET /api/v1/supplier/stocks?dateFrom=2019-06-20T00:00:00` — остатки: `quantity`, `inWayToClient`, `inWayFromClient`, `Price`, `Discount`. Метод могут заменить отчётом об остатках из Аналитики — проверь документацию.
- **Документы** `https://documents-api.wildberries.ru`: `GET /api/v1/documents/list`, `GET /api/v1/documents/download?serviceName=…&extension=pdf` — файл в base64.
- **Продвижение** `https://advert-api.wildberries.ru`: `GET /adv/v1/promotion/count` — список кампаний по статусам (9 идёт, 11 пауза, 7 завершена); статистика `GET /adv/v3/fullstats?ids=…&beginDate=…&endDate=…` (старый вариант — `POST /adv/v2/fullstats`). Поля: `sum` (расход), `views`, `clicks`, `orders`, `sum_price` (сумма заказов), по дням `days[]`. До 50 кампаний за запрос, лимит строгий.

## Ozon Seller — https://docs.ozon.ru/api/seller

- **Авторизация:** заголовки `Client-Id` и `Api-Key`. Ключ: Настройки → API ключи, роль Admin read only. Все методы — POST с JSON.
- `POST /v1/analytics/data` — `{date_from, date_to, metrics:["revenue","ordered_units"], dimension:["day"], limit, offset}` → `result.data[].dimensions[0].id` (дата), `metrics[]`.
- `POST /v3/finance/transaction/totals` — `{date:{from,to}, transaction_type:"all"}` → `accruals_for_sale`, `sale_commission`, `processing_and_delivery`, `refunds_and_cancellations`, `services_amount`, `compensation_amount`, `others_amount`. Комиссии и расходы приходят со знаком минус.
- `POST /v2/analytics/stock_on_warehouses` — остатки по складам: `item_code`, `free_to_sell_amount`, `promised_amount`.

## Ozon Performance (реклама) — https://docs.ozon.ru/api/performance

- Отдельный кабинет и отдельные ключи (`client_id`, `client_secret`): performance.ozon.ru → Настройки → API.
- Токен: `POST https://api-performance.ozon.ru/api/client/token` `{client_id, client_secret, grant_type:"client_credentials"}` → `access_token` (живёт ~30 минут), дальше `Authorization: Bearer …`.
- `GET /api/client/campaign` — кампании; `GET /api/client/statistics/daily/json?dateFrom=…&dateTo=…` — по дням: `moneySpent`, `views`, `clicks`, `orders`, `ordersMoney`. Числа могут прийти строками с запятой.

## amoCRM — https://www.amocrm.ru/developers

- `https://<поддомен>.amocrm.ru/api/v4`, `Authorization: Bearer <долгосрочный токен>` (Интеграции → Создать интеграцию).
- `GET /leads/pipelines` — воронки и этапы; служебные статусы: **142** — успешно, **143** — закрыто и не реализовано.
- `GET /leads?limit=250&page=N` — сделки: `name`, `price`, `status_id`, `responsible_user_id`, `created_at`, `closed_at` (unix-время).
- `PATCH /leads/<id>` `{status_id}` — перенос этапа; `POST /leads` `[{name, price}]` — новая сделка.

## Битрикс24 — https://apidocs.bitrix24.ru

- Входящий вебхук вида `https://<портал>.bitrix24.ru/rest/<user>/<код>/` с правами `crm`; метод — `<вебхук><метод>.json`.
- `crm.status.list` с фильтром `ENTITY_ID: DEAL_STAGE` — этапы (`EXTRA.SEMANTICS`: success / failure); `crm.deal.list` — сделки, постранично по 50 (`start`, `next`); `crm.deal.update`, `crm.deal.add`.

## Т-Банк Бизнес — https://developer.tbank.ru/docs/api

- `Authorization: Bearer <токен>`, выпускается в интернет-банке → Интеграции.
- `GET https://business.tbank.ru/openapi/api/v4/bank-accounts` — счета и остатки (`balance.otb`).
- `GET /api/v1/statement?accountNumber=…&from=…&to=…` — выписка. Названия полей операций сверяй с документацией: в BrandOS разбор сделан с запасными вариантами.

## Точка — https://enter.tochka.com/doc

- `Authorization: Bearer <JWT>`; `GET https://enter.tochka.com/uapi/open-banking/v1.0/balances` → `Data.Balance[]` (`accountId`, `type`, `Amount.amount`). Выписки в Точке формируются асинхронно — отдельный запрос и ожидание.

## Диадок — https://developer.kontur.ru

- Ключ разработчика, логин и пароль. `POST /V3/Authenticate?type=password` с заголовком `Authorization: DiadocAuth ddauth_api_client_id=<ключ>` → токен; дальше `…,ddauth_token=<токен>`.
- `GET /GetMyOrganizations` → `BoxId`; `GET /V3/GetDocuments?boxId=…&filterCategory=Any.InboundNotRevoked`; содержимое — `GET /V4/GetEntityContent`. В BrandOS это экспериментальный коннектор — проверять на реальном ящике.

## Telegram Bot API — https://core.telegram.org/bots/api

- Токен от @BotFather. `getUpdates?offset=<последний update_id + 1>` — новые сообщения; документы в `message.document`, фото в `message.photo[]` (последний — самый крупный).
- `getFile?file_id=…` → `file_path`; файл: `https://api.telegram.org/file/bot<токен>/<file_path>`. Лимит скачивания — 20 МБ.

## Частые ошибки

| Ошибка | Причина |
|---|---|
| 401 / 403 | Неверный или просроченный токен, у токена не отмечена нужная категория (WB), не та роль (Ozon) |
| 429 | Превышен лимит. WB Статистика и Продвижение — самые строгие: делай паузу ~60 секунд |
| Пустые данные Ozon Performance | Не тот кабинет: ключи Seller API к рекламе не подходят |
| Почта не подключается | Нужен пароль приложения, а не обычный пароль; IMAP должен быть включён в настройках ящика |
