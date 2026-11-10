import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma('busy_timeout=5000');
    db.pragma('journal_mode=WAL');
    db.pragma('synchronous=FULL');
    db.pragma('foreign_keys=ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
