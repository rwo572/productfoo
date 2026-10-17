CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  team_id INT REFERENCES teams(id),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE teams ( id SERIAL PRIMARY KEY, name TEXT NOT NULL, plan TEXT DEFAULT 'free' );
CREATE TABLE api_keys ( id SERIAL PRIMARY KEY, team_id INT REFERENCES teams(id), key_hash TEXT, last_used_at TIMESTAMPTZ );
CREATE TABLE documents ( id SERIAL PRIMARY KEY, team_id INT REFERENCES teams(id), author_id INT REFERENCES users(id), title TEXT, body TEXT );
CREATE TABLE comments ( id SERIAL PRIMARY KEY, document_id INT REFERENCES documents(id), author_id INT REFERENCES users(id), body TEXT );
CREATE TABLE api_requests ( id BIGSERIAL PRIMARY KEY, team_id INT, endpoint TEXT, created_at TIMESTAMPTZ DEFAULT now() );
