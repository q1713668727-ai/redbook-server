var mysql = require('mysql');

var pool = mysql.createPool({
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  waitForConnections: true,
  queueLimit: Number(process.env.DB_QUEUE_LIMIT || 0),
  acquireTimeout: Number(process.env.DB_ACQUIRE_TIMEOUT || 10000),
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  port: process.env.DB_PORT || '3306',
  password: process.env.DB_PASSWORD || '159357',
  database: process.env.DB_NAME || 'server',
  charset: process.env.DB_CHARSET || 'utf8mb4'
});

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => {
      if (err) {
        reject(err);
        return;
      }
      connection.query(sql, params, (queryErr, results) => {
        connection.release();
        if (queryErr) reject(queryErr);
        else resolve(results);
      });
    });
  });
}

module.exports = query;
