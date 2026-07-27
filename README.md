# FOTOhub AI dla Shoper / FOTOhub AI for Shoper

Aplikacja FOTOhub dla sklepów Shoper: masowe generowanie zdjęć produktowych, usuwanie i podmiana tła, upscaling, opisy i teksty SEO generowane przez AI — wszystko w trybie "najpierw szkic": nic nie trafia do sklepu bez Twojej akceptacji.

FOTOhub app for Shoper stores: bulk product photo generation, background removal/replacement, upscaling, AI descriptions and SEO copy — all draft-first: nothing is written to the live store without your approval.

---

## Polski

### Czym jest ta aplikacja

Mała aplikacja serwerowa (Node.js + TypeScript) z panelem w przeglądarce, który można osadzić jako iframe w panelu administracyjnym Shoper. Komunikuje się z dwoma systemami:

- **Shoper REST API** (`{sklep}/webapi/rest/...`) — odczyt produktów, kategorii i zdjęć oraz zapis zatwierdzonych zmian,
- **FOTOhub commerce-bridge** (`https://apis.fotohub.app/v1/commerce`) — kolejkowanie masowych zadań AI (zdjęcia, opisy) i pobieranie wyników.

### Funkcje

- kreator połączenia: klucz API FOTOhub (`fh_live_...`) + dane webapi Shoper, walidacja i rejestracja połączenia,
- wybór produktów z filtrami: brak opisu, mniej niż N zdjęć, kategoria, wyszukiwanie tekstowe,
- galeria presetów (w tym preset kanału **"Zdjęcia zgodne z Allegro"**), zapamiętywany preset domyślny,
- wycena przed uruchomieniem: "N produktów x M obrazów = X kredytów (masz Y)" z twardą blokadą przy braku kredytów,
- masowe zadania: generowanie zdjęć, edycja, usuwanie/podmiana tła, upscale, zmiana koloru, opisy, teksty ALT, kompletna karta produktu,
- podgląd postępu na żywo z tabelą per-produkt, przyciskami "Ponów nieudane" i "Anuluj"; stan przeżywa odświeżenie strony,
- **szkice (draft-first)**: wyniki AI trafiają do lokalnej bazy SQLite; przegląd przed/po, zatwierdzanie pojedynczo lub zbiorczo — dopiero zatwierdzenie zapisuje do sklepu,
- generator opisów: 6 tonów, języki PL/EN/DE, wybór pól (tytuł, krótki opis, pełny opis, meta tytuł, meta opis, ALT, FAQ),
- licznik kredytów w nagłówku z ostrzeżeniem poniżej 50 kredytów,
- strona pomocy MCP: podłączenie Claude Desktop / Cursor do `https://apis.fotohub.app/mcp/`,
- pełne tłumaczenia PL (domyślne) i EN (`?lang=en`).

### Instalacja jako aplikacja prywatna (dostęp webapi)

1. W panelu Shoper przejdź do **Ustawienia → Webapi** (lub **Aplikacje → Moje aplikacje** w nowszych panelach) i utwórz dostęp webapi:
   - utwórz **grupę dostępu** z uprawnieniami do odczytu i zapisu: *Produkty*, *Zdjęcia produktów*, *Kategorie*,
   - utwórz **użytkownika webapi** przypisanego do tej grupy (login + hasło), **lub** wygeneruj stały token dostępu, jeśli Twój panel to umożliwia.
2. Skopiuj `.env.example` do `.env` i uzupełnij:
   - `SHOPER_STORE_URL` — adres sklepu, np. `https://sklep123456.shoparena.pl`,
   - `SHOPER_ACCESS_TOKEN` — stały token webapi, **albo** `SHOPER_LOGIN` + `SHOPER_PASSWORD` (aplikacja sama pobierze token przez `POST /webapi/rest/auth` i odświeży go po wygaśnięciu),
   - `FOTOHUB_API_KEY` — klucz z panelu FOTOhub (https://fotohub.app → Console → API Keys),
   - `FOTOHUB_CONFIG_SECRET` — hasło szyfrujące lokalny magazyn sekretów, **wymagane**, minimum 16 znaków (`openssl rand -hex 32`); bez niego aplikacja nie wystartuje,
   - `ADMIN_TOKEN` — wspólny sekret wymagany na każdym wywołaniu `/api`. Puste = **panel bez uwierzytelnienia**: każdy, kto dosięgnie portu, może wydawać kredyty i zapisywać do sklepu. Ustaw go zawsze, gdy `HOST` nie jest `127.0.0.1` (dotyczy też Dockera),
   - `PUBLIC_URL` — publiczny adres tej aplikacji (dla webhooków bridge), jeśli dostępny.

Warianty produktu: opcja **Uwzględnij warianty produktu** przekazuje AI listę
kombinacji opcji (rozmiary, kolory), więc opisy mogą się do nich odnosić. Shoper
przechowuje zdjęcia **na poziomie produktu**, nie wariantu — nowe zdjęcie trafia
do galerii produktu, a nazwa wariantu tylko do tekstu ALT. Szczegóły w sekcji
angielskiej niżej.
3. Zainstaluj i uruchom:

```bash
npm install
npm run build
npm start
# panel: http://127.0.0.1:8811
```

4. Otwórz panel, przejdź przez kreator połączenia i zacznij od zakładki **Produkty**.

Dane logowania można też podać w kreatorze w przeglądarce — są zapisywane zaszyfrowane (AES-256-GCM) w lokalnej bazie SQLite i mają pierwszeństwo przed `.env`.

### Osadzenie w panelu Shoper (iframe)

Aplikację można dodać jako własny moduł/odnośnik w panelu Shoper wskazujący na publiczny adres aplikacji. UI jest lekki (vanilla JS) i poprawnie działa w iframe.

---

## English

### What this app is

A small Node.js + TypeScript server app with a browser admin panel (embeddable as an iframe inside the Shoper admin). It talks to two systems:

- **Shoper REST API** (`{store}/webapi/rest/...`) — reads products, categories and images, and writes approved changes back,
- **FOTOhub commerce-bridge** (`https://apis.fotohub.app/v1/commerce`) — queues bulk AI jobs (images, copy) and fetches results.

### Features

- connection wizard: FOTOhub API key (`fh_live_...`) + Shoper webapi credentials, validated and registered as a bridge connection,
- product picker with filters: missing description, fewer than N images, category, text search,
- preset gallery (including the **"Allegro-compliant photos"** channel preset), per-store default preset,
- cost preflight: "N products x M images = X credits (you have Y)" with a hard block when insufficient,
- bulk jobs: image generation, editing, background removal/replacement, upscale, recolor, descriptions, alt texts, complete listing,
- live progress with a per-item table, retry-failed and cancel buttons; state survives page reloads,
- **draft-first write-back**: AI results land in a local SQLite draft store; before/after review, per-item or bulk approval — only approval writes to the live product,
- description generator: 6 tones, PL/EN/DE languages, field selection (title, short/long description, meta title, meta description, alt text, FAQ),
- credits meter in the header with a low-balance warning under 50 credits,
- MCP help page: connect Claude Desktop / Cursor to `https://apis.fotohub.app/mcp/`,
- full PL (default) and EN (`?lang=en`) translations.

### Install as a private app (webapi access)

1. In the Shoper admin go to **Settings → Webapi** (or **Apps → My apps** on newer panels) and create webapi access:
   - create an **access group** with read/write permissions for *Products*, *Product images*, *Categories*,
   - create a **webapi user** in that group (login + password), **or** issue a permanent access token if your panel supports it.
2. Copy `.env.example` to `.env` and fill in:
   - `SHOPER_STORE_URL` — your store URL, e.g. `https://shop123456.shoparena.pl`,
   - `SHOPER_ACCESS_TOKEN` — permanent webapi token, **or** `SHOPER_LOGIN` + `SHOPER_PASSWORD` (the app obtains a bearer token via `POST /webapi/rest/auth` and refreshes it on expiry),
   - `FOTOHUB_API_KEY` — key from the FOTOhub console (https://fotohub.app → Console → API Keys),
   - `FOTOHUB_CONFIG_SECRET` — any long passphrase encrypting the local secret store,
   - `PUBLIC_URL` — public base URL of this app (for bridge webhooks), if reachable.
3. Install and run:

```bash
npm install
npm run build
npm start
# panel: http://127.0.0.1:8811
```

4. Open the panel, complete the connection wizard, and start from the **Products** tab.

Credentials can also be entered in the browser wizard — they are stored encrypted (AES-256-GCM) in the local SQLite database and take precedence over `.env`.

### Docker

```bash
docker build -t fotohub-shoper .
docker run -p 8811:8811 --env-file .env -v fotohub-shoper-data:/app/data fotohub-shoper
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPER_STORE_URL` | yes* | Store URL (`https://...`) |
| `SHOPER_ACCESS_TOKEN` | yes*/or | Permanent webapi token |
| `SHOPER_LOGIN` / `SHOPER_PASSWORD` | yes*/or | Webapi user credentials (auto token refresh) |
| `FOTOHUB_API_KEY` | yes* | `fh_live_...` / `fh_test_...` key |
| `FOTOHUB_CONFIG_SECRET` | **yes** | Passphrase encrypting the config store. The app refuses to start without at least 16 characters — there is no default, because a shipped fallback would encrypt every install's credentials with the same public constant. Generate with `openssl rand -hex 32`. |
| `ADMIN_TOKEN` | recommended | Shared secret required on every `/api` call. **Unset means the panel is unauthenticated.** |
| `TRUST_PROXY` | no | Set to `1` only behind a reverse proxy you control (see below) |
| `PUBLIC_URL` | no | Public base URL for webhook callbacks |
| `PORT` | no | Default `8811` |
| `HOST` | no | Default `127.0.0.1` (set `0.0.0.0` in Docker) |
| `DATA_DIR` | no | SQLite location, default `./data` |

\* every value can instead be entered in the connection wizard.

### Access control

The panel drives a merchant's live catalogue and spends FOTOhub credits, so
reaching the port is equivalent to holding the store's credentials. There are two
layers:

- **`ADMIN_TOKEN` (shared secret).** When set, every `/api` request must present
  it as `Authorization: Bearer <token>` or `X-Admin-Token: <token>`; anything
  else gets `401`. The gate runs before the CSRF check, so an unauthenticated
  caller cannot even read the panel's state or collect a CSRF token.
- **CSRF token.** Issued per process by `GET /api/status` and required in
  `X-CSRF-Token` on every mutating request. This stops a cross-site page, but it
  is *not* access control: any client that can reach the port can simply read the
  token from `/api/status`.

When `ADMIN_TOKEN` is unset the app keeps working and logs a warning at boot,
because forcing a token on upgrade would lock an existing merchant out of their
own panel. In that configuration binding to `127.0.0.1` is the only thing
protecting the store — so set a token whenever `HOST` is not loopback (including
Docker, where `HOST` is typically `0.0.0.0`).

### Rate limits

Mutating `/api` routes are throttled per client address, per minute, because each
one costs either a Shoper round trip or real credits:

| Bucket | Routes | Budget |
|--------|--------|--------|
| spend | job submit, retry-failed, draft approve/reject/approve-all | 20/min |
| connect | `/api/connect`, `/api/disconnect` | 10/min |
| mutation | settings, language, default preset, validate-key | 60/min |

Reads are not throttled (the dashboard polls them). Over budget returns `429`
with a `Retry-After` header in seconds plus `retry_after_ms` in the body.

The limiter keys on the socket address. `X-Forwarded-For` is honoured **only**
when `TRUST_PROXY=1`; enabling it without a trusted proxy in front lets any
client forge a fresh quota per request.

### Product variants (`include_variants`)

Set `include_variants: true` on `POST /api/jobs`, or tick **Uwzględnij warianty
produktu** / **Include product variants** in the job wizard, to fold a product's
option combinations into the context sent to the model.

What a merchant gets:

- the variant list (e.g. `Rozmiar: 42, Kolor: czerwony`) is read from
  `/product-stocks` and joined with human-readable option and value labels, so
  generated copy can reference real sizes and colours instead of inventing them,
- inactive variants are excluded when at least one is active,
- one extra Shoper request per product; if the webapi user lacks the
  `/product-stocks` permission the lookup is skipped rather than failing the job.

What it does **not** do:

- it does not attach a generated photo to an individual variant. Shoper stores
  images **per product**, not per `product-stocks` row, so a variant photo is
  uploaded to the parent product's gallery with the option combination folded
  into its ALT text. There is no per-variant image slot to write to.
- it does not write variant-specific descriptions; text write-back always targets
  the product translation.

### API docs

- FOTOhub: https://docs.fotohub.app
- Shoper: https://developers.shoper.pl

## License

MIT
