import * as uuid from "uuid";
import * as express from "express";
import * as bcrypt from "bcrypt";
import * as fs from "fs";
import * as mysql from "mysql";
import { User } from "./user";
import { Statistic } from "./statistic";
import { strToIntArr } from "./util";
import { sqlQuery } from "./sql";
import { Storage } from "@google-cloud/storage";
import RateLimit from "express-rate-limit";

require('dotenv').config();

const app = express();

// Implement rate-limiting to protect against DoS attacks.
// Allow a maximum of five requests per minut
const limiter = RateLimit({
    windowMs: 60000, // 1 minute
    max: 60
});
app.use(limiter);

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

const storage = new Storage({ keyFilename: 'webapp-service-account.json' });

app.use(express.static("public"));
app.use(express.json());
app.set('views', './views');
app.set('view engine', 'ejs')

app.post('/updateCallRegistry', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let dateStr = body.date;
    let entries = body.entries;

    if (!token || !dateStr || !entries) {
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

    if (user.perm > 9) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    let queryString = "INSERT INTO tblCalls (date, value, dID) VALUES ";
    let params = [];

    if (entries.length !== null && entries.length < 10e4) {
        for (let entry of entries) {
            let baseDate = new Date(dateStr);
            baseDate.setDate(baseDate.getDate() + entry.dow);

            for (let i = 0; i < entry.calls.length; i++) {
                if (entry.calls[i] === 0)
                    continue;
                queryString += "(?, ?, ?), ";
                params.push(baseDate.toISOString().split('T')[0], i + 1, entry.calls[i]);
            }
        }
        queryString = queryString.substr(0, queryString.length - 2) + ';';
        console.log(queryString);
        console.log(params);
        await sqlQuery(queryString, params);
        res.json({status: "ok", message: "Call registry updated"}).end();
    } else {
        res.status(200).json({stats: "error", message: "Illegal parameter"}).end();
    }
})

app.get('/statistics/:token/:sd/:ed', async (req, res) => {
    let startDate = req.params.sd;
    let endDate = req.params.ed;
    let token = req.params.token;

    if (!token || !startDate || !endDate) {
        res.send("ERROR: Some parameters are missing!").end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.send("ERROR: Invalid token format!").end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.send("ERROR: Invalid or expired token!").end();
        return;
    }

    let historicalStats = await sqlQuery("SELECT * FROM tblOldStats;");
    let callData = await sqlQuery("SELECT * FROM tblCalls WHERE date >= ? AND date <= ?;", [startDate, endDate]);
    let doctors = await sqlQuery("SELECT * FROM tblDoctors ORDER BY surname, name;");
    let holidays = await sqlQuery("SELECT * FROM tblHolidays WHERE date >= ? AND date <= ?;", [startDate, endDate]);

    let statistics = {};
    for (let i = 0; i < doctors.length; i++) {
        let found = false;
        let stat = new Statistic();

        for (let hs of historicalStats) {
            if (hs.dID === doctors[i].id) {
                found = true;
                stat = new Statistic();
                stat.weekdayCalls = strToIntArr(hs.weekdayCalls);
                stat.weekendCalls = strToIntArr(hs.weekendCalls);
                stat.christmasCalls = strToIntArr(hs.christmasCalls);
                stat.newYearCalls = strToIntArr(hs.newYearCalls);
                stat.holidayCalls = strToIntArr(hs.holidayCalls);
                stat.easterCalls = strToIntArr(hs.easterCalls);
            }
        }

        statistics[doctors[i].id.toString()] = stat;
    }

    for (let cd of callData) {
        let date = new Date(cd.date);
        if (date.getMonth() === 11 && (date.getDate() === 25 || date.getDate() === 26)) {
            statistics[cd.dID.toString()].addChristmasCall(cd.value);
        } else if (date.getMonth() === 0 && date.getDate() === 1) {
            statistics[cd.dID.toString()].addNewYearCall(cd.value);
        } else {
            let isHoliday = false;
            let isEaster = false;
            for (let h of holidays) {
                let hDate = new Date(h.date);
                if (hDate.toISOString() === date.toISOString()) {
                    if (h.name.toLowerCase().includes("easter"))
                        isEaster = true;
                    else
                        isHoliday = true;
                    break;
                }
            }
            if (isHoliday && date.getDay() > 0 && date.getDay() < 6)
                statistics[cd.dID.toString()].addHolidayCall(cd.value);
            else if (isEaster) {
                statistics[cd.dID.toString()].addEasterCall(cd.value);
            }
            else {
                if (date.getDay() in [ 0, 6 ]) {
                    statistics[cd.dID.toString()].addWeekendCall(cd.value);
                } else {
                    statistics[cd.dID.toString()].addWeekdayCall(cd.value);
                }
            }
        }
    }

    let totals = new Statistic();
    let averages = new Statistic();

    for (let d of doctors) {
        for (let i = 0; i < 3; i++) {
            totals.weekdayCalls[i] += statistics[d.id.toString()].weekdayCalls[i];
            averages.weekdayCalls[i] += statistics[d.id.toString()].weekdayCalls[i];
        }
        for (let i = 0; i < 3; i++) {
            totals.weekendCalls[i] += statistics[d.id.toString()].weekendCalls[i];
            averages.weekendCalls[i] += statistics[d.id.toString()].weekendCalls[i];
        }
        for (let i = 0; i < 3; i++) {
            totals.holidayCalls[i] += statistics[d.id.toString()].holidayCalls[i];
            averages.holidayCalls[i] += statistics[d.id.toString()].holidayCalls[i];
        }
    }

    for (let i = 0; i < 3; i++)
        averages.weekdayCalls[i] /= doctors.length - 1;
    for (let i = 0; i < 3; i++)
        averages.weekendCalls[i] /= doctors.length - 1;
    for (let i = 0; i < 3; i++)
        averages.holidayCalls[i] /= doctors.length - 1;

    let tableContents = '';
    tableContents += Statistic.getTableHeader();
    for (let d of doctors) {
        let doctorName = `${d.name} ${d.surname}`;
        tableContents += statistics[d.id.toString()].getTableRow(doctorName);
    }

    tableContents += totals.getTotalRow();
    tableContents += averages.getAverageRow();

    res.render('statistics', {
        pageTitle: `Statistics from ${startDate} to ${endDate}`,
        statsFrom: `Call statistics from ${startDate} to ${endDate}`,
        tableData: tableContents
    });
});

app.get('/printOut/:id/:sr/:ws', async (req, res) => {

    let bucket = storage.bucket('nelanest-roster');
    let file = bucket.file(`render_tmp/${req.params.id}.scsv`);
    await file.download(async (err, contents) => {

        if (err !== null) {
            res.status(404).send("Couldn't find a roster with that ID!");
        }

        let tableContents = '';
        let lines = contents.toString().split('\n');
        let header = lines[0].split(',');
        let doctorNames = lines[1].split(',');

        let seperators = [4, 8, 13, 17, 20];

        tableContents += '<thead>';
        for (let i = 0; i < header.length; i++) {
            if (header[i] === '')
                continue;
            let span = (header[i + 1] === '') ? 2 : 1;

            for (let j = 0; j < seperators.length; j++) {
                if (seperators[j] === i) {
                    if (span > 1) {
                        seperators[j] += 1;
                    }
                }
            }

            tableContents += `<th style="text-align:center;" colspan=${span}>${header[i]}</th>`;
        }
        tableContents += '</thead>\n';

        let colgroup = '';
        colgroup += '<colgroup>'
        for (let i = 0; i < header.length; i++) {
            let doSep = false;
            for (let sep of seperators) {
                if (sep === i) {
                    doSep = true;
                    break;
                }
            }
            if (doSep)
                colgroup += '<col style="width:50px;border-right:4px solid;">'
            else
                colgroup += '<col style="width:50px;">\n';
        }
        colgroup += '</colgroup>\n';

        tableContents = colgroup + tableContents;

        tableContents += '<tr>';
        for (let i = 0; i < doctorNames.length; i++) {
            tableContents += `<td style="text-align:center;font-weight:bold;">${doctorNames[i]}</td>`
        }
        tableContents += '</tr>';

        for (let i = 2; i < lines.length - 1; i++) {
            let fields = lines[i].split(',');

            // if (i - 2 === 3 || i - 2 === 6 || i - 2 === 11) {
            //     tableContents += '<tr style="border-right: 4px solid white;">\n'
            // } else {
            // }
            tableContents += '<tr>';

            for (let f of fields) {
                let bg = (f[0] === '#') ? "#4ca644" : "white";
                let sub = (f[0] === '#') ? 1 : 0;
                tableContents +=
                    `<td style="height:40px;background:${bg};">${f.substr(sub, 15)}</td>`;

            }

            tableContents += '</tr>\n';
        }

        let doctors = await sqlQuery("SELECT * FROM tblDoctors ORDER BY surname, name");
        let doctorTableData = '<tr>';
        let columns = 0;
        for (let d of doctors) {
            if (columns === 6) {
                columns = 0;
                doctorTableData += "</tr><tr>";
            }
            doctorTableData += `<td>${d.surname}, ${d.name}</td><td>${d.shortcode}</td>`;
            columns++;
        }
        doctorTableData += '</tr>';

        res.render('printOut', {
            scheduleHeading: req.params.sr.replace(/\+/g, ' '),
            weekStarting: 'Week starting: ' + decodeURIComponent(req.params.ws),
            pageTitle: 'Schyfts Renderer',
            tableData: tableContents,
            doctorInfo: doctorTableData
        });

    });

});

app.post('/deleteSurgeonLeave', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let surname = body.surname;
    let startDate = body.startDate;

    if (!token || !surname || !startDate) {
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

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblSurgeonLeave WHERE surname = ? AND start = ?", [surname, startDate]);
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }
    res.status(200).json({ status: "ok", message: "Surgeon leave removed" }).end();
});

app.post('/addSurgeonLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let name = body.name;
    let surname = body.surname;
    let startDate = body.startDate;
    let endDate = body.endDate;

    if (!token || !name || !surname || !startDate || !endDate) {
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

    if (user.perm > 29) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    try {
        await sqlQuery("INSERT INTO tblSurgeonLeave (name, surname, start, end) VALUES (?, ?, ?, ?);",
            [name, surname, startDate, endDate]);
        res.status(200).json({ status: "ok", message: "Surgeon leave added" }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }

});

app.post('/getAllSurgeonLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;

    if (!token) {
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

    if (user.perm > 30) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

app.get('/cleanUp', async (req, res) => {
    let bucket = storage.bucket('nelanest-roster');
    bucket.getFiles({ prefix: 'render_tmp' })
    .then(files => {
        let toDelete = files[0];
        for (let i = 0; i < files.length; i++) {
            console.log(`Deleting file ${toDelete[i].name}...`);
            toDelete[i].delete().catch(err => console.log(err));
        }
        res.status(200).json({ status: "ok", message: `Deleted ${toDelete.length} files from "render_tmp/"` });
    }).catch(err => {
        res.status(500).json({ status: "error", message: "An unknown error has occurred" });
        console.error(err);
    });
});

    try {
        let results = await sqlQuery("SELECT * FROM tblSurgeonLeave;");
        res.status(200).json({ status: "ok", results }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }

});

function checkUser(user, perms): Promise<boolean> {
    return new Promise(((resolve) => {
        if (!user) {
            resolve(false);
            return;
        }

        if (perms !== null && user.permissionLevel >= perms) {
                resolve(false);
                return;
        }

        resolve(true);
    }));
}

app.post('/addCall', async (req, res) => {
    let token = req.body.token;
    let body = req.body;
    let dID = body.dID;
    let date = body.date;
    let value = body.value;

    let user;

    try {
        user = await User.fromToken(token);
        await checkUser(user, 30);
    } catch (e) {
        console.error(e);
        res.status(400).json({ status: "error", code: e.code, message: error_codes[e.code]});
        return;
    }

    if (!date || !value) {
        res.status(400).json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    try {
        await sqlQuery("INSERT INTO tblCalls (date, value, dID) VALUES (?, ?, ?);", [date, value, dID]);
        res.status(200).json({ status: "ok", message: "Added call", ack: { date, value, dID } });
    } catch (e) {
        res.status(500).json({status: "error", message: `Server error: ${e}`});
    }
});

app.post('/getAllCalls', async (req, res) => {

    let token = req.body.token;

    let user;
    try {
        user = await User.fromToken(token);
        await checkUser(user, 30);
    } catch (e) {
        console.error(e);
        res.status(400).json({ status: "error", code: e.code, message: error_codes[e.code]});
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblCalls;");
        res.status(200).json({ status: "ok", message: `Fetched ${results.length} results.`, results })
    } catch (e) {
        res.status(500).json({ status: "error", code: 0, message: `Server error: ${e}` });
    }

});

app.post('/deleteCall', async (req, res) => {

    let token = req.body.token;
    let id = req.body.id;

    let user;
    try {
        user = User.fromToken(token);
        await checkUser(user, 30);
    } catch (e) {
        console.error(e);
        res.status(400).json({ status: "error", code: e.code, message: error_codes[e.code]});
        return;
    }

    if (id === null) {
        res.status(400).json({ status:"error", code: 1, message: error_codes[1] });
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblCalls WHERE id = ?", [id]);
        res.status(200).json({ status: "ok", message: `Deleted call (id: ${id})` });
    } catch (e) {
        res.status(500).json({ status: "error", code: 0, message: `Server error: ${e}` });
    }
});

app.post('/getSharedModules', async (req, res) => {

    let body = req.body;
    let token = body.token;

    if (!token) {
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

    if (user.perm > 19) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblSharedModules;");
        res.status(200).json({ status: "ok", message: `Got ${results.length} shared modules`, results }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error (${JSON.stringify(e)})` }).end();
    }

});

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
    let startDate = body.startDate;
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

    sqlString += "WHERE dID = ? AND start = ?";
    fields.push(dID, startDate);

    try {
        await sqlQuery(sqlString, fields);
    } catch (e) {
        res.status(500).json({ status: "error", message: e });
        return;
    }

    res.status(200).json({ status: "ok", message: "Edit successfull", ack: edit }).end();

});

app.post('/deleteLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let dID = body.dID;
    let startDate = body.startDate;

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

    if (user.perm > 27) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] }).end();
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblLeave WHERE dID = ? AND DATE(start) = DATE(?);", [dID, startDate]);
    } catch (e) {
        res.status(500).json({ status: "error", message: `SQL Query failed with: (${e})` }).end();
        return;
    }

    res.status(200).json({ status: "ok", message: `Deleted leave starting at ${startDate} for dID: ${dID}` }).end();

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

app.post('/getAllUsers', async (req, res) => {

    let body = req.body;
    let token = body.token;

    if (!token) {
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

    if (user.perm > 10) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] });
        return;
    }

    try {

        let results = await sqlQuery("SELECT uID, uName, uEmail, uPerm FROM tblUsers;");
        res.status(200).json({ status: "ok", message: `Got ${results.length} results`, results });

    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error: ${JSON.stringify(e)}`}).end();
    }

});

app.post('/getSetting', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let key = body.key;

    if (!token || !key) {
        res.status(400).json({status: "error", code: 11, message: error_codes[11]}).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    try {
        let result = await sqlQuery("SELECT * FROM tblOptions WHERE key_string = ?", [key]);
        result = result[0];
        res.status(200).json({ status: "ok", message: "Fetched setting value", result }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error: ${JSON.stringify(e)}` }).end();
    }

});

app.post('/setSetting', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let key = body.key;
    let value = body.value;

    if (!token || key === undefined || value === undefined) {
        res.status(400).json({status: "error", code: 11, message: error_codes[11]}).end();
        return;
    }

    if (!token.match(TOKEN_FORMAT)) {
        res.status(400).json({status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    let user = await User.fromToken(token);
    if (!user) {
        res.status(400).json({status: "error", code: 25, message: error_codes[25]}).end();
        return;
    }

    try {
        let result = await sqlQuery("SELECT * FROM tblOptions WHERE key_string = ?", [key]);
        if (result.length !== 0) {
            await sqlQuery("UPDATE tblOptions SET `value` = ? WHERE key_string = ?", [value, key]);
            res.status(200).json({ status: "ok", message: "Setting updated", ack: { key_string: key, value } });
        } else {
            await sqlQuery("INSERT INTO tblOptions (key_string, `value`) VALUES (?, ?)", [key, value]);            res.status(200).json({ status: "ok", message: "Setting updated", ack: { key, value } });
            res.status(200).json({ status: "ok", message: "Setting created", ack: { key_string: key, value } });
        }
    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error: ${JSON.stringify(e)}` });
    }

});

app.post('/editUser', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let uID = body.uID;
    let edit = body.edit;

    if (!token || !uID || !edit) {
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

    if (user.perm > 9) {
        res.status(200).json({ status: "error", code: 1, message: error_codes[1] });
        return;
    }

    let sqlString = "UPDATE tblUsers SET ";
    let params = [];
    if (edit.uEmail) {
        sqlString += "uEmail = ?, ";
        params.push(edit.uEmail);
    }
    if (edit.uPerm !== undefined) {
        sqlString += "uPerm = ?";
        params.push(edit.uPerm);
    } else {
        sqlString = sqlString.substr(0, sqlString.length - 2);
    }
    sqlString += " WHERE uID = ?;";
    params.push(uID);

    try {
        await sqlQuery(sqlString, params);
        res.status(200).json({ status: "ok", message: `User (id: ${uID}) edited`, ack: edit }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error: ${JSON.stringify(e)}` });
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

    sqlConnection.query('SELECT uID, uPerm, uHash FROM tblUsers WHERE uName = ?', [uname], (err, results) => {
        if (err) {
            res.json({ status: 'error', code: 21, message: error_codes[21] }).end();
        } else {

            if (!(results[0].uHash && results[0].uID)) {
                res.status(200).json({status: "error", code: 23, message: error_codes[23]}).end();
                return;
            }

            let hash = results[0].uHash;
            let uID = results[0].uID;
            let uPerm = results[0].uPerm;
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

                    res.json({ status: 'ok', message: 'Logged in', token, permissionLevel: uPerm }).end();
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