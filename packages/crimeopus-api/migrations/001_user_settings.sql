CREATE TABLE IF NOT EXISTS user_settings (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('dark','light','auto')),
  language TEXT NOT NULL DEFAULT 'it' CHECK (language IN ('it','en')),
  updated_at INTEGER NOT NULL
);
