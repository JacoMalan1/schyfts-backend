import * as express from "express";
import * as bcrypt from "bcrypt";
import * as fs from "fs";
import * as mysql from "mysql";
import { User } from "./user";
import { Statistic } from "./statistic";
import { strToIntArr } from "./util";
import {sqlCommit, sqlQuery, sqlRollback, sqlStartTransaction} from "./sql";
import { Storage } from "@google-cloud/storage";
import RateLimit from "express-rate-limit";
import {APIResponse} from "./APIResponse";

require('dotenv').config();

const app = express();

// Implement rate-limiting to protect against DoS attacks.
// Allow a maximum of five requests per minute
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

app.post('/getCallData', async (req, res) => {
   let token = req.body.token;
   let startDate = req.body.start;
   let endDate = req.body.end;

   if (!token || !startDate || !endDate) {
       res.json(new APIResponse(false, "Missing parameters"));
       return;
   }

   if (!await User.checkAuth(token, 10)) {
       res.json(new APIResponse(false, "Authentication failure"));
       return;
   }

   try {
       let results = await sqlQuery("SELECT date, dID, value FROM tblCalls WHERE date >= ? AND date <= ?",
           [startDate, endDate]);
       res.json(new APIResponse(true, `Got ${results.length} results`, { results }));
   } catch (e) {
       res.json(new APIResponse(false, "An unknown server error occurred"));
   }
});

app.post('/updateCallRegistry', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let dateStr = body.date;
    let entries = body.entries;

    let SQL_HOST = process.env.SQL_HOST;
    let SQL_USER = process.env.SQL_USER;
    let SQL_PASS = process.env.SQL_PASS;
    let SQL_DB = process.env.SQL_DB;

    if (!token || !dateStr || !entries) {
        res.json(new APIResponse(false, "Missing variables")).end();
        return;
    }

    if (!await User.checkAuth(token, 9)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

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

    // Clear the database for this week before we insert the data
    try {
        let baseDate = new Date(dateStr);
        let baseDateStr = baseDate.toISOString().split('T')[0];
        await sqlStartTransaction(sqlConnection);
        console.log("START TRANSACTION");
        await sqlQuery(
            "DELETE FROM tblCalls WHERE date >= ? AND date < ? + INTERVAL 7 DAY;",
            [baseDateStr, baseDateStr], sqlConnection
        );
        console.log("DELETE");
    } catch (e) {
        console.log(e);
        res.json(new APIResponse(false, "Unknown server error occurred"));
        await sqlRollback(sqlConnection);
        console.log("ROLLBACK");
        return;
    }

    let queryString = "INSERT INTO tblCalls (date, value, dID) VALUES ";
    let params = [];

    try {
        if (entries.length !== null && entries.length === 7) {
            for (let entry of entries) {
                let baseDate = new Date(dateStr);
                if (!Number.isInteger(entry.dow)) {
                    await sqlRollback(sqlConnection);
                    console.log("ROLLBACK");
                    res.json(new APIResponse(false, "dow must be an integer"));
                    return;
                }
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
            await sqlQuery(queryString, params, sqlConnection);
            console.log("QUERY");
            await sqlCommit(sqlConnection);
            console.log("COMMIT");
            res.json(new APIResponse(true, "Call registry updated")).end();
        } else {
            await sqlRollback(sqlConnection)
            console.log("ROLLBACK;");
            res.json(new APIResponse(false, "Illegal parameter/s")).end();
        }
    } catch (e) {
        console.log(e);
        await sqlRollback(sqlConnection);
        console.log("ROLLBACK;");
        res.json(new APIResponse(false, "Unknown server error occurred"));
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

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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
            statistics[cd.dID.toString()].addChristmasCall(cd.value); // Christmas
        } else if (date.getMonth() === 0 && date.getDate() === 1) {
            statistics[cd.dID.toString()].addNewYearCall(cd.value); // New Year
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
        }
        const day = date.getDay()
        if (day === 5 || day == 6 || day == 0) {
            if (date.getDay() === 5) {
                statistics[cd.dID.toString()].addWeekendCall(cd.value);
            }
        } else {
            statistics[cd.dID.toString()].addWeekdayCall(cd.value);
        }
    }

    let totals = new Statistic();
    let averages = new Statistic();

    const sharedModules = await sqlQuery("SELECT * FROM tblSharedModules;");
    const halfWeightDoctors: number[] = [];
    for (const m of sharedModules) {
        const ids = JSON.parse(`[${m.doctors}]`);
        halfWeightDoctors.push(...ids);
    }

    const numModules = doctors.length - sharedModules.length;

    for (let d of doctors) {
        const weight = halfWeightDoctors.find(element => element === d['id']) === undefined ?
            1 / numModules : 1 / (2 * numModules);

        // console.log(`Doctor: ${JSON.stringify(d)}\nWeight: ${weight}`);
        for (let i = 0; i < 3; i++) {
            totals.weekdayCalls[i] += statistics[d.id.toString()].weekdayCalls[i];
            averages.weekdayCalls[i] += statistics[d.id.toString()].weekdayCalls[i] * weight;
        }
        for (let i = 0; i < 3; i++) {
            totals.weekendCalls[i] += statistics[d.id.toString()].weekendCalls[i];
            averages.weekendCalls[i] += statistics[d.id.toString()].weekendCalls[i] * weight;
        }
        for (let i = 0; i < 3; i++) {
            totals.holidayCalls[i] += statistics[d.id.toString()].holidayCalls[i];
            averages.holidayCalls[i] += statistics[d.id.toString()].holidayCalls[i] * weight;
        }
    }

    // Doing a weighted sum, so we don't need this
    // for (let i = 0; i < 3; i++)
    //     averages.weekdayCalls[i] /= doctors.length - 1;
    // for (let i = 0; i < 3; i++)
    //     averages.weekendCalls[i] /= doctors.length - 1;
    // for (let i = 0; i < 3; i++)
    //     averages.holidayCalls[i] /= doctors.length - 1;

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

app.get('/matrix/:token', async (req, res) => {
    let token = req.params.token;

    if (!token) {
        res.send('Missing token parameter');
        return;
    }

    if (!await User.checkAuth(token, 20)) {
        res.status(403).end();
        return;
    }

    const bucket = storage.bucket('nelanest-roster');
    const file = bucket.file('matrix.csv');
    await file.download(async (err, contents) => {
        if (err) {
            res.status(404).end();
            return;
        }

        const lines = contents.toString().split('\n');

        const cols = lines[0].split(',').length + 1;
        let table = '<thead><th>Day</th>';
        for (let i = 1; i < cols; i++)
            table += '<th>' + i + '</th>';
        table += '</thead>'

        let days = [
            'Mon AM', 'Mon PM',
            'Tue AM', 'Tue PM', '' +
            'Wed AM', 'Wed PM',
            'Thu AM', 'Thu PM',
            'Fri AM', 'Fri PM',
            'Sat', 'Sun'
        ];

        let i = 0;
        for (const line of lines) {
            if (!line)
                continue;

            table += '<tr>';
            table += '<td>' + days[i++] + '</td>';

            for (const col of line.split(','))
                table += '<td>' + col + '</td>';
            table += '</tr>';
        }

        res.render('matrix', {
            pageTitle: 'Schyfts Matrix',
            tableData: table,
        });
    });
})

app.get('/printOut/:id/:sr/:ws', async (req, res) => {
    let id = req.params.id;
    let sr = req.params.sr;
    let ws = req.params.ws;

    if (!id || !sr || !ws) {
        res.send("ERROR: Missing parameters!");
    }

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

        let separators = [0, 4, 8, 13, 17, 20];

        tableContents += '<thead>';
        for (let i = 0; i < header.length; i++) {
            if (header[i] === '')
                continue;

            let span = (header[i + 1] === '') ? 2 : 1;

            for (let j = 0; j < separators.length; j++) {
                if (separators[j] === i) {
                    if (span > 1) {
                        separators[j] += 1;
                    }
                }
            }

            tableContents += `<th style="text-align:center;border-top: 4px solid;" colspan=${span}>${header[i]}</th>`;
        }
        tableContents += '</thead>\n';

        let colgroup = '';
        colgroup += '<colgroup>'
        for (let i = 0; i < header.length; i++) {
            let doSep = false;
            for (let sep of separators) {
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
            tableContents += `<td style="text-align:center;font-weight:bold;border-bottom: 4px solid;">${doctorNames[i]}</td>`;
        }
        tableContents += '</tr>';

        for (let i = 2; i < lines.length - 1; i++) {
            let fields = lines[i].split(',');

            tableContents += '<tr>';

            for (let f of fields) {
                let bg = (f[0] === '#') ? "#4ca644" : "white";
                let sub = (f[0] === '#') ? 1 : 0;
                if ((i - 1) % 2 == 0)
                    tableContents += `<td style="height:40px;background:${bg};border-bottom:4px solid;">${f.substr(sub, 15)}</td>`;
                else
                    tableContents += `<td style="height:40px;background:${bg};">${f.substr(sub, 15)}</td>`;
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
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblSurgeonLeave WHERE surname = ? AND start = ?", [surname, startDate]);
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }
    res.json({ status: "ok", message: "Surgeon leave removed" }).end();
});

app.post('/addSurgeonLeave', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let name = body.name;
    let surname = body.surname;
    let startDate = body.startDate;
    let endDate = body.endDate;

    if (!token || !name || !surname || !startDate || !endDate) {
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        await sqlQuery("INSERT INTO tblSurgeonLeave (name, surname, start, end) VALUES (?, ?, ?, ?);",
            [name, surname, startDate, endDate]);
        res.json({ status: "ok", message: "Surgeon leave added" }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }
});

app.post('/getAllSurgeonLeave', async (req, res) => {
    let body = req.body;
    let token = body.token;

    if (!token) {
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblSurgeonLeave;");
        res.json({ status: "ok", results }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: e }).end();
    }
});

app.get('/cleanUp', async (req, res) => {
    let bucket = storage.bucket('nelanest-roster');
    bucket.getFiles({ prefix: 'render_tmp' })
        .then(files => {
            let toDelete = files[0];
            for (let i = 0; i < files.length; i++) {
                console.log(`Deleting file ${toDelete[i].name}...`);
                toDelete[i].delete().catch(err => console.log(err));
            }
            res.json({ status: "ok", message: `Deleted ${toDelete.length} files from "render_tmp/"` });
        }).catch(err => {
        res.status(500).json({ status: "error", message: "An unknown error has occurred" });
        console.error(err);
    });
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

    if (!date || !value || !token || !dID) {
        res.json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        await sqlQuery("INSERT INTO tblCalls (date, value, dID) VALUES (?, ?, ?);", [date, value, dID]);
        res.json({ status: "ok", message: "Added call", ack: { date, value, dID } });
    } catch (e) {
        res.status(500).json({status: "error", message: `Server error: ${e}`});
    }
});

app.post('/getAllCalls', async (req, res) => {
    let token = req.body.token;

    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblCalls;");
        res.json({ status: "ok", message: `Fetched ${results.length} results.`, results })
    } catch (e) {
        res.status(500).json({ status: "error", code: 0, message: `Server error: ${e}` });
    }
});

app.post('/deleteCall', async (req, res) => {
    let token = req.body.token;
    let id = req.body.id;

    if (!id || !token) {
        res.json({ status:"error", code: 1, message: error_codes[1] });
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblCalls WHERE id = ?", [id]);
        res.json({ status: "ok", message: `Deleted call (id: ${id})` });
    } catch (e) {
        res.status(500).json({ status: "error", code: 0, message: `Server error: ${e}` });
    }
});

app.post('/getSharedModules', async (req, res) => {
    let body = req.body;
    let token = body.token;

    if (!token) {
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblSharedModules;");
        res.json({ status: "ok", message: `Got ${results.length} shared modules`, results }).end();
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
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 28)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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
    res.json({ status: "ok", message: "Doctor record updated", ack: { edit } }).end();
});

app.post('/deleteDoctor', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let id = body.id;

    if (!token || !id) {
        res.json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!await User.checkAuth(token, 26)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    await sqlQuery("DELETE FROM tblDoctors WHERE id = ?", [id]);
    res.json({ status: "ok", message: `Delete doctor (id: ${id})` });
});

app.post('/addDoctor', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let shortcode = body.shortcode;
    let cellphone = body.cellphone;
    let name = body.name;
    let surname = body.surname;

    if (!token || !shortcode || !cellphone || !name || !surname) {
        res.json({ status: "error", code: 11, message: error_codes[11] });
        return;
    }

    if (!await User.checkAuth(token, 27)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    let shortcodeFormat = /^\*\d{5}$/;
    if (!shortcode.match(shortcodeFormat)) {
        res.json({ status: "error", code: 41 , message: error_codes[41] }).end();
        return;
    }

    let cellFormat = /^\d{10}$/;
    if (!cellphone.match(cellFormat)) {
        res.json({ status: "error", code: 42, message: error_codes[42] }).end();
        return;
    }

    await sqlQuery(
        "INSERT INTO tblDoctors (shortcode, cellphone, name, surname) VALUES (?, ?, ?, ?);",
        [shortcode, cellphone, name, surname]
    );

    res.json({
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
    let token = req.body.token;
    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let doctors_Q = await sqlQuery("SELECT * FROM tblDoctors;");
        res.json(new APIResponse(true, `${doctors_Q.length} results`, { results: doctors_Q }));
    } catch (e) {
        res.json(new APIResponse(false, "An unknown server error occurred"));
    }
});

app.post('/addLeave', async (req, res) => {

    let body = req.body;
    let dID = body.id;
    let startDate = body.startDate;
    let endDate = body.endDate;
    let token = body.token;

    if (!token || !dID || !startDate || !endDate) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    await sqlQuery("INSERT INTO tblLeave (dID, start, end) VALUES (?, ?, ?);", [dID, startDate, endDate]);
    res.json({ status: "ok", message: "Added leave", ack: { id: dID, startDate, endDate } });

});

app.post('/getAllLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;

    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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

    res.json({ status: "ok", results });

});

app.post('/editLeave', async (req, res) => {

    let body = req.body;
    let token = body.token;
    let dID = body.dID;
    let startDate = body.startDate;
    let edit = body.edit;

    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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

    res.json({ status: "ok", message: "Edit successfull", ack: edit }).end();

});

app.post('/deleteLeave', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let dID = body.dID;
    let startDate = body.startDate;

    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 27)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        await sqlQuery("DELETE FROM tblLeave WHERE dID = ? AND DATE(start) = DATE(?);", [dID, startDate]);
        res.json(new APIResponse(true, `Deleted leave starting at ${startDate} for dID: ${dID}`));
    } catch (e) {
        res.status(500).json({ status: "error", message: `SQL Query failed with: (${e})` }).end();
    }
});

app.post('/getLeave', async (req, res) => {

    let body = req.body;
    let dID = body.id;
    let token = body.token;

    if (!token || !dID) {
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 29)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let results = await sqlQuery("SELECT * FROM tblLeave WHERE dID = ?", [dID]);
        res.json(new APIResponse(true, `${results.length} results found`, { results })).end();
    } catch (e) {
        res.json(new APIResponse(false, "An unknown server error occurred"));
    }

});

app.post('/getDoctor', async (req, res) => {
    let body = req.body;
    let surname = body.surname;
    let token = body.token;

    if (token === undefined || surname === undefined || token.length <= 0 || surname .length <= 0) {
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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
            res.json({status: "error", code: 1, message: error_codes[1]}).end();
            return;
        }

        results = await sqlQuery("SELECT * FROM tblDoctors WHERE surname = ?;", [surname]);
        res.json({ status: "ok", message: `${results.length} results found`, results }).end();

    } else {
        res.json({ status: "error", code: 25,message: error_codes[25] }).end();
    }

});

app.post('/getAllUsers', async (req, res) => {
    let token = req.body.token;
    if (!token) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 10)) {
        res.json(new APIResponse(false, "Authentication failure"));
        return;
    }

    try {
        let results = await sqlQuery("SELECT uID, uName, uEmail, uPerm FROM tblUsers;");
        if (results.length === 0) {
            res.json(new APIResponse(false, "The query returned no results. The user database appears to be empty."));
            return;
        }
        res.json(new APIResponse(true, `Got ${results.length} results`, { results }))
    } catch (e) {
        res.json(new APIResponse(false, "An unknown server error has occurred"));
    }
});

app.post('/getSetting', async (req, res) => {
    let token = req.body.token;
    let key = req.body.key;

    if (!token || !key) {
        res.json(new APIResponse(false, "Missing parameters"));
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure"));
        return;
    }

    try {
        let valueQuery = await sqlQuery("SELECT key_string, value FROM tblOptions WHERE key_string = ?", [key]);
        if (valueQuery.length !== 1) {
            res.json(new APIResponse(false, "No such key!"));
            return;
        }

        let value = valueQuery[0].value;
        let key_string = valueQuery[0].key_string;
        res.json(new APIResponse(true, "Fetched setting value", { result: { key_string, value } }));
    } catch (e) {
        res.json(new APIResponse(false, "An unknown error has occurred"));
    }
});

app.post('/setSetting', async (req, res) => {
    let body = req.body;
    let token = body.token;
    let key = body.key;
    let value = body.value;

    if (!token || key === undefined || value === undefined) {
        res.json({status: "error", code: 11, message: error_codes[11]}).end();
        return;
    }

    if (!await User.checkAuth(token, 30)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
        return;
    }

    try {
        let result = await sqlQuery("SELECT * FROM tblOptions WHERE key_string = ?", [key]);
        if (result.length !== 0) {
            await sqlQuery("UPDATE tblOptions SET `value` = ? WHERE key_string = ?", [value, key]);
            res.json({ status: "ok", message: "Setting updated", ack: { key_string: key, value } });
        } else {
            await sqlQuery("INSERT INTO tblOptions (key_string, `value`) VALUES (?, ?)", [key, value]);            res.json({ status: "ok", message: "Setting updated", ack: { key, value } });
            res.json({ status: "ok", message: "Setting created", ack: { key_string: key, value } });
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
        res.json({ status: "error", code: 11, message: error_codes[11] }).end();
        return;
    }

    if (!await User.checkAuth(token, 9)) {
        res.json(new APIResponse(false, "Authentication failure")).end();
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
        res.json({ status: "ok", message: `User (id: ${uID}) edited`, ack: edit }).end();
    } catch (e) {
        res.status(500).json({ status: "error", message: `Internal server error: ${JSON.stringify(e)}` });
    }

});

app.post('/login', async (req, res) => {
    let uname = req.body.uname;
    let pword = req.body.pword;

    if (!uname || !pword) {
        res.json(new APIResponse(false, "Missing parameters!"));
        return;
    }

    let userInfo = await sqlQuery("SELECT uID, uName, uHash, uPerm FROM tblUsers WHERE uName = ?", [uname]);
    if (userInfo.length !== 1) {
        res.json(new APIResponse(false, "No such user"));
        return;
    }

    let dbHash = userInfo[0].uHash;
    let id = userInfo[0].uID;
    let permissionLevel = userInfo[0].uPerm;
    try {
        let same = await bcrypt.compare(pword, dbHash);
        if (same) {
            let user = new User(id, permissionLevel);
            let token = await user.makeToken(10);
            res.json(new APIResponse(true, "Logged in", { token, permissionLevel: userInfo[0].uPerm}));
        } else {
            console.log(`Authentication failure for user id ${id}`);
            res.json(new APIResponse(false, "Incorrect password"));
        }
    } catch (e) {
        res.json(new APIResponse(false, "An unknown error has occurred!"));
    }

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