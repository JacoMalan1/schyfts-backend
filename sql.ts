import * as mysql from 'mysql'
import * as fs from 'fs'

export function sqlStartTransaction(con: mysql.Connection): Promise<void> {
    return new Promise((resolve, reject) => {
        con.beginTransaction((err) => {
            if (err)
                reject(err)
            else
                resolve();
        })
    });
}

export function sqlCommit(con: mysql.Connection): Promise<void> {
    return new Promise((resolve, reject) => {
        con.commit((err) => {
            if (err)
                reject(err)
            else
                resolve();
        })
    });
}

export function sqlRollback(con: mysql.Connection): Promise<void> {
    return new Promise((resolve, reject) => {
        con.rollback(err => {
            if (err)
                reject(err)
            else
                resolve();
        })
    });
}

export function sqlQuery(query: string, params?: Array<any>, con?: mysql.Connection): Promise<any[]> {

    let SQL_HOST = process.env.SQL_HOST;
    let SQL_USER = process.env.SQL_USER;
    let SQL_PASS = process.env.SQL_PASS;
    let SQL_DB = process.env.SQL_DB;

    let sqlConnection = con;

    if (!con) {
        sqlConnection = mysql.createConnection({
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
    }

    if (params) {

        return new Promise((resolve, reject) => {
            sqlConnection.query(query, params, (err, results) => {
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