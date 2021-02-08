const mysql = require('mysql');
const fs = require('fs');

function sqlQuery(query, f) {

    let SQL_HOST = process.env.SQL_HOST;
    let SQL_USER = process.env.SQL_USER;
    let SQL_PASS = process.env.SQL_PASS;
    let SQL_DB = process.env.SQL_DB;

    let sqlConnection = mysql.createConnection({
        host: `${SQL_HOST}`,
        user: `${SQL_USER}`,
        password: `${SQL_PASS}`,
        database: `${SQL_DB}`,
        ssl: {
            ca: fs.readFileSync('server-ca.pem'),
            cert: fs.readFileSync('client-cert.pem'),
            key: fs.readFileSync('client-key.pem')
        }
    });

    if (f) {

        return new Promise((resolve, reject) => {
            sqlConnection.query(query, f, (err, results) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

    } else {

        return new Promise((resolve, reject) => {
            sqlConnection.query(query, (err, results) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });

    }
}

module.exports = sqlQuery;