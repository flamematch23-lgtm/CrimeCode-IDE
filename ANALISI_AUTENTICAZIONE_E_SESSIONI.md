# Analisi CrimeCode-IDE: Autenticazione, Sessioni e Architettura

Documento generato da esplorazione approfondita del codebase per comprendere l'implementazione attuale di autenticazione, persistenza e comunicazione tra componenti.

---

## 1. AUTENTICAZIONE (Authentication)

### 1.1 Metodi di Autenticazione Supportati

#### A. **Telegram Magic-Link (Primario - Cloud)**
- **Location**: `packages/opencode/src/license/auth.ts` + `packages/app/src/pages/auth-gate.tsx`
- **Flow**:
  1. Client chiama `POST /license/auth/start` con `device_label`
  2. Server genera PIN (8 caratteri, base32 non ambiguo)
  3. Client riceve: `{ pin, bot_url, expires_at }`
  4. User apre Telegram bot `@CrimeCodeSub_bot` con deep-link `https://t.me/CrimeCodeSub_bot?start=auth_<PIN>`
  5. Bot reclama il PIN e associa customer_id
  6. Client esegue polling: `GET /license/auth/poll/<PIN>` ogni 2 secondi
  7. Server ritorna JWT session token dopo approvazione

- **Database**: 
  - Tabella: `auth_pins` - TTL: 10 minuti
  - Campi: `pin`, `customer_id` (null inizialmente), `created_at`, `expires_at`, `claimed_at`, `device_label`

- **Token JWT**: 
  - Formato: `S1.<base64_payload>.<hmac_signature>`
  - Payload: `{ sub: customer_id, tg: telegram_user_id, sid: session_id, iat, exp }`
  - Secret: `LICENSE_HMAC_SECRET` (env var, >= 32 chars)
  - TTL: 30 giorni
  - HMAC: SHA256

#### B. **Username/Password Auth (Secondario)**
- **Location**: `packages/opencode/src/license/auth.ts` linee 312+
- **Sign-Up**: `POST /license/auth/signup`
  - Campi: `username`, `password`, `telegram` (optional), `email` (optional), `device_label`
  - Validazione username: `/^[a-zA-Z0-9_.-]{3,32}$/`
  - Password: min 8 chars, max 256
  - Hash: **scrypt** (OWASP 2023 secure params)
    - N=16384 (2^14), r=8, p=1
    - Tempo hash: <250ms su shared-cpu

- **Sign-In**: `POST /license/auth/signin`
  - Campi: `username`, `password`, `device_label`
  - Ritorna token JWT identico a Telegram flow

- **Database**:
  - Tabella: `password_accounts`
  - Campi: `customer_id`, `username`, `password_hash`, `password_salt`, `created_at`, `revoked_at`

#### C. **Self-Hosted Basic Auth (Legacy)**
- **Location**: `packages/app/src/utils/auth-fetch.ts`
- **Header**: `Authorization: Basic ${btoa(username:password)}`
- **Uso**: Per installazioni on-premise con opencode server locale
- **Deprecato**: Supportato ma non più primario

---

### 1.2 Gestione Sessioni

#### **Session Storage**

**Desktop (Electron)**:
- **Location**: `packages/desktop-electron/src/main/auth/service.ts`
- **Storage**: Electron Store (`electron-store`) - file JSON su disco
- **Path**: `~/.opencode/` oppure OS-specific app data dir
- **Key**: `"session"` (singular)
- **Format**:
  ```typescript
  {
    token: string,          // JWT
    customer_id: string,
    telegram_user_id: number | null,
    expires_at: number,     // Unix timestamp (sec)
    signed_in_at: number    // Unix timestamp (sec)
  }
  ```

**Web**:
- **Location**: `packages/app/src/utils/teams-client.ts` + `auth-gate.tsx`
- **Storage**: Browser `localStorage`
- **Key**: `"crimecode.session"`
- **Format**: identico a Desktop
- **Caveat**: Solo HTTPS, dati restano nel browser

#### **Session Validation**
- **Location**: `packages/opencode/src/license/auth.ts` linee 68-99
- **Processo**:
  1. Parse JWT (estrai payload, verifica signature)
  2. Check DB: `SELECT * FROM auth_sessions WHERE id = ?`
  3. Se revoked_at è NOT NULL → session revocata
  4. Se exp < now → session scaduta
  5. Se tutto ok → payload validato

#### **Session Lifecycle**
- **Creazione**: 
  - Telegram: dopo claim del PIN
  - Password: dopo successo signin/signup
  - DB insert: `auth_sessions { id, customer_id, created_at, last_seen_at, device_label }`

- **Touch/Keep-Alive**: 
  - `POST /license/auth/touch` - aggiorna `last_seen_at`
  - Chiamato implicitamente ad ogni API call autenticata (middleware in `server.ts`)

- **Revoca**:
  - `POST /license/auth/logout` - set `revoked_at = NOW`
  - Immediato: token diventa invalido
  - Per desktop: chiama IPC `window.api.account.logout()`
  - Per web: cancella localStorage

- **List Sessions**:
  - `GET /license/auth/sessions` - mostra device_label, created_at, last_seen_at, revoked_at
  - User può revocare sessioni individuali (multi-device logout)

---

### 1.3 Approval Gate (Admin Approval)

- **Location**: `packages/opencode/src/license/auth.ts` linee 389-402
- **Tabella**: `customers { id, approval_status, rejected_reason }`
- **Stati**:
  1. **pending** - User registrato ma admin non ha approvato
  2. **approved** - Admin ha approvato, session token rilasciato
  3. **rejected** - Admin ha rifiutato, motivo in `rejected_reason`

- **Flow Pending**:
  - Client riceve `202 Accepted` con `{ status: "pending", customer_id }`
  - Client mostra UI "In attesa di approvazione"
  - Client esegue polling: `GET /license/auth/status/<customer_id>` ogni 5s
  - Quando admin approva → `pollAuth()` rilascia token
  - Quando admin rifiuta → UI mostra motivo

- **Admin Approval**: 
  - Dashboard: `POST /license/admin/customers/<id>/approve`
  - Parametri: `trialDays`
  - Notifica Telegram: inviata automaticamente al customer

---

## 2. PERSISTENZA DATI - DATABASE SCHEMA

### 2.1 Database Setup
- **Engine**: SQLite
- **Location**: Per project: `<project_root>/.opencode/` (Drizzle)
- **Per Cloud**: SQLite centralizzato (Fly.io deployment)
- **ORM**: Drizzle
- **Migrations**: File in `packages/opencode/migration/`

### 2.2 Tabelle Principali

#### **auth_pins** (Telegram auth temporaneo)
```sql
CREATE TABLE auth_pins (
  pin TEXT PRIMARY KEY,
  customer_id TEXT,           -- NULL fino a quando bot reclama
  created_at INTEGER,
  expires_at INTEGER,         -- TTL: 10 min
  claimed_at INTEGER,         -- NULL fino a quando bot non reclama
  device_label TEXT
);
```

#### **auth_sessions** (Active sessions)
```sql
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,        -- ses_<base64>
  customer_id TEXT,
  created_at INTEGER,
  last_seen_at INTEGER,       -- Aggiornato ad ogni richiesta
  revoked_at INTEGER,         -- NULL se attivo
  device_label TEXT           -- "Device on OS" per identificare
);
```

#### **password_accounts** (Username/password storage)
```sql
CREATE TABLE password_accounts (
  customer_id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,         -- Scrypt hash
  password_salt TEXT,
  created_at INTEGER,
  revoked_at INTEGER
);
```

#### **customers** (User profiles)
```sql
CREATE TABLE customers (
  id TEXT PRIMARY KEY,        -- cus_<base64>
  approval_status TEXT,       -- 'pending', 'approved', 'rejected'
  rejected_reason TEXT,
  telegram TEXT,              -- @handle normalizzato minuscolo
  telegram_user_id INTEGER,   -- Telegram user ID
  email TEXT,
  note TEXT,                  -- Note da admin
  created_at INTEGER
);
```

#### **sync_kv** (Key-value per user - cross-device sync)
```sql
CREATE TABLE sync_kv (
  customer_id TEXT,
  key TEXT,
  value TEXT,                 -- Max 64KB per key
  updated_at INTEGER,
  PRIMARY KEY (customer_id, key)
);
```
- **Uso**: Sincronizzazione preferenze/recenti tra dispositivi
- **API**: `GET/PUT /license/sync/<key>`

#### **session** (Sessioni di coding)
```typescript
// Da session.sql.ts
SessionTable {
  id: SessionID,              -- Primary key
  project_id: ProjectID,      -- Foreign key
  workspace_id: WorkspaceID,  -- Nullable
  parent_id: SessionID,       -- Nullable (child sessions)
  slug: string,
  directory: string,
  title: string,
  version: string,
  share_url: string,
  summary_additions: number,
  summary_deletions: number,
  summary_files: number,
  summary_diffs: Snapshot.FileDiff[],
  revert: object,
  permission: Permission.Ruleset,
  time_created: number,
  time_updated: number,
  time_compacting: number,
  time_archived: number
}
```

#### **message** (Chat messages in session)
```typescript
// Da session.sql.ts
MessageTable {
  id: MessageID,
  session_id: SessionID,      -- Foreign key
  time_created: number,
  time_updated: number,
  data: MessageV2.Info        -- JSON blob
}
```

#### **part** (Messag
