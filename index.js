//Srequire('@google-cloud/debug-agent').start({ serviceContext: { enableCanary: false } });

// ========= MODULES ========== //
const uuid      = require('uuid');
const express   = require('express');
const bcrypt    = require('bcrypt');
const fs        = require('fs');
const mysql     = require('mysql');
const User      = require('./user.js');
const sqlQuery  = require('./sql.js');
// ============================ //

require('dotenv').config();

const app = express();
const saltRounds = 10;

const SQL_HOST = process.env.SQL_HOST;
const SQL_USER = process.env.SQL_USER;
const SQL_PASS = process.env.SQL_PASS;
const SQL_DB = process.env.SQL_DB;

const sqlConnection = mysql.createConnection({
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

const TOKEN_FORMAT = /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/g;

const error_codes = {
    0: 'Undefined error',
    1: 'Insufficient permissions',
    10: 'Invalid message',
    11: 'Missing required fields',
    20: 'Login error',
    21: 'Incorrect username',
    22: 'Incorrect password',
    23: 'User does not exist',
    24: 'Login token not provided',
    25: 'Invalid or expired login token',
    30: 'Registration error',
    31: 'Username already exists',
    32: 'Email already registered',
    40: 'Invalid doctor information',
    41: 'Invalid shortcode',
    42: 'Invalid cellphone number'
};

app.use(express.json());

app.post('/editDoctor', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let id = body.id;
    let edit = body.edit;

    if (!token || !id || !edit) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25] }).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25] }).end();
        return;
    }

    if (user.perm > 28) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let sqlString = String("UPDATE tblDoctors SET ");
    let params = [];

    if (edit.shortcode) {
        sqlString += "shortcode = ?,";
        params.push(edit.shortcode);
    }
    if (edit.cellphone) {
        sqlString += "cellphone = ?,";
        params.push(edit.cellphone);
    }
    if (edit.name) {
        sqlString += "name = ?,";
        params.push(edit.name);
    }
    if (edit.surname) {
        sqlString += "surname = ?,";
        params.push(edit.surname);
    }

    sqlString = sqlString.substr(0, sqlString.length - 1);
    sqlString += " WHERE id = ?;";
    params.push(id);
    await sqlQuery(sqlString, params);
    res.status(200).json({ status: "ok", message: "Doctor record updated", ack: { edit } }).end();

});

app.post('/deleteDoctor', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let id = body.id;

    if (!token || !id) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 26) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    await sqlQuery("DELETE FROM tblDoctors WHERE id = ?", [id]);
    res.status(200).json({ status: "ok", message: `Delete doctor (id: ${id})` });

});

app.post('/addDoctor', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let shortcode = body.shortcode;
    let cellphone = body.cellphone;
    let name = body.name;
    let surname = body.surname;

    if (!token || !shortcode || !cellphone || !name || !surname) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 27) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let shortcodeFormat = /^\*\d{5}$/;
    if (!shortcode.match(shortcodeFormat)) {
        res.status(400).json({ status: "error", code: 41 , message: error_codes[41] }).end();
        return;
    }

    let cellFormat = /^\d{10}$/;
    if (!cellphone.match(cellFormat)) {
        res.status(400).json({ status: "error", code: 42, message: error_codes[42] }).end();
        return;
    }

    await sqlQuery(
        "INSERT INTO tblDoctors (shortcode, cellphone, name, surname) VALUES (?, ?, ?, ?);",
        [shortcode, cellphone, name, surname]
    );

    res.status(200).json({
        status: "ok",
        message: "Doctor added",
        ack: {
            shortcode,
            cellphone,
            name,
            surname
        }
    }).end();

});

app.post('/getAllDoctors', async (req, res) => {

    let body = req.body;
    let token = body.token;
    if (!token) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let doctors_Q = await sqlQuery("SELECT * FROM tblDoctors;");
    res.status(200)
        .json({ status: "ok", message: `${doctors_Q.length} results`, results: doctors_Q }).end();

});

app.post('/addLeave', async (req, res) => {

    let body = req.body;
    let dID = body.id;
    let startDate = body.startDate;
    let endDate = body.endDate;
    let token = body.token;

    if (!token || !dID || !startDate || !endDate) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] });
        return;
    }

    await sqlQuery("INSERT INTO tblLeave (dID, start, end) VALUES (?, ?, ?);", [dID, startDate, endDate]);
    res.status(200).json({ status: "ok", message: "Added leave", ack: { id: dID, startDate, endDate } });

});

app.post('/getAllLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;

    if (!token) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let results = [];

    try {
        let leaveResults = await sqlQuery("SELECT * FROM tblLeave;");
        for (let leave of leaveResults) {

            let doctorResults = await sqlQuery("SELECT * FROM tblDoctors WHERE id = ?", [leave.dID]);
            results.push({ doctor: doctorResults[0], leaveData: leave });

        }

    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
        return;
    }

    res.status(200).json({ status: "ok", results });

});

app.post('/editLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let dID = body.dID;
    let edit = body.edit;

    if (!token) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let sqlString = "UPDATE tblLeave SET ";
    let fields = [];
    if (edit.startDate) {
        sqlString += "start = ?, "
        fields.push(edit.startDate);
    }
    if (edit.endDate) {
        sqlString += "end = ?, "
        fields.push(edit.endDate);
    }
    if (edit.dID) {
        sqlString += "dID = ?";
        fields.push(dID);
    } else {
        sqlString = sqlString.substr(0, sqlString.length - 2);
    }

    try {
        await sqlQuery(sqlString, fields);
    } catch (e) {
        res.status(500).json({ status: "error", message: e });
        return;
    }

    res.status(200).json({ status: "ok", message: "Edit successfull", ack: edit }).end();

});

app.post('/getLeave', async (req, res) => {

    let body = req.body;
    let dID = body.id;
    let token = body.token;

    if (!token || !dID) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] });
        return;
    }

    let results = await sqlQuery("SELECT * FROM tblLeave WHERE dID = ?", [dID]);
    res.status(200).json({ status: "ok", message: `${results.length} results found`, results }).end();

});

app.post('/getDoctor', async (req, res) => {

    let body = req.body;
    let surname = body.surname;
    let token = body.token;

    if (token === undefined || surname === undefined || token.length <= 0 || surname .length <= 0) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({ status: "error", code: 25, message: error_codes[25] }).end();
        return;
    }

    let results;
    try {
        results = await sqlQuery("SELECT * FROM tblTokens WHERE token = ? AND expires > CURRENT_TIMESTAMP();", [token]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: "error", code: 0, message: error_codes[0] }).end();
        return;
    }
    if (results.length === 1) {

        let uID = results[0].uID;
        results = await sqlQuery("SELECT uPerm FROM tblUsers WHERE uID = ?;", [uID]);
        if (results[0].uPerm > 19) {
            res.status(400).json({status: "error", code: 1, message: error_codes[1]}).end();
            return;
        }

        results = await sqlQuery("SELECT * FROM tblDoctors WHERE surname = ?;", [surname]);
        res.json({ status: "ok", message: `${results.length} results found`, results }).end();

    } else {
        res.status(200).json({ status: "error", code: 25,message: error_codes[25] }).end();
    }

});

app.post('/login', (req, res) => {

    let body = req.body;
    if (!body.uname || !body.pword) {
        res.status(400)
            .json({status: "error", code: 11, message: "Missing arguments 'uname' or 'pword'"}).end();
        return;
    }

    let pword = body.pword;
    let uname = body.uname;

    sqlConnection.query('SELECT uID, uHash FROM tblUsers WHERE uName = ?', [uname], (err, results) => {
        if (err) {
            res.json({ status: 'error', code: 21, message: error_codes[21] }).end();
        } else {

            if (!(results[0].uHash && results[0].uID)) {
                res.status(200).body({status: "error", code: 23, message: error_codes[23]}).end();
                return;
            }

            let hash = results[0].uHash;
            let uID = results[0].uID;
            bcrypt.compare(pword, hash, (error, same) => {
                if (same) {
                    console.log(`Successful login (${uname})`);

                    let token = uuid.v4();
                    console.log(`Generated token ${token} for user ${uname}`);
                    sqlConnection.query(
                        `INSERT INTO tblTokens (token, uID, expires) VALUES (?, ${uID}, TIMESTAMP(now() + INTERVAL 10 HOUR));`,
                        [token],
                        err => { if (err) console.error(err); }
                    );

                    res.json({ status: 'ok', message: 'Logged in', token }).end();
                } else {
                    console.log(`Login failed (${uname})`);
                    res.json({ status: 'error', code: 22, message: error_codes[22] }).end();
                }
            });
        }
    });

});

app.post('/register', (req, res) => {

    let body = req.body;
    console.log(`Received register request ${body}`);
    let pword = body.pword;
    let uname = body.uname;
    let email = body.email;

    bcrypt.hash(pword, saltRounds).then(hash => {

        sqlConnection.query('SELECT uName FROM tblUsers WHERE uName = ? UNION SELECT uEmail FROM tblUsers WHERE uEmail = ?;', [uname, email], (err, results) => {

            if (results.length > 0) {
                res.json({ status: 'error', code: 30, message: error_codes[30] }).end();
            } else {

                sqlConnection.query('INSERT INTO tblUsers (uName, uHash, uEmail) VALUES (?, ?, ?);', [uname, hash, email]);
                res.json({ status: 'ok', message: 'Registered', ack: { uname, pword, email } }).end();
                console.log(`User registered ${{ uname, email }}`);

            }

        });

    });

});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}...`);
});
