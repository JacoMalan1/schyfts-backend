const sqlQuery = require('./sql.js');
const uuid = require('uuid');

class User {

    constructor(id, perm, token) {

        this.id = id;
        this.token = token;
        this.perm = perm;

    }

}

User.register = async function(uname, email, pword, perm) {

    let user_Q = await sqlQuery(
        "SELECT uName, uEmail FROM tblUsers WHERE uName = ? OR uEmail = ?;",
        [uname, email]
    );

    if (user_Q.length > 0)
        return null;

    let hash = await bcrypt.hash(pword, saltRounds);
    await sqlQuery(
        "INSERT INTO tblUsers (uName, uEmail, uHash, uPerm) VALUES (?, ?, ?, ?);",
        [uname, email, hash, perm]
    );

    let id_Q = await sqlQuery("SELECT uID FROM tblUsers WHERE uName = ?;", [uname]);
    let id = id_Q[0].uID;
    let user = new User(id, perm);
    return await user.makeToken(8);

}

User.prototype.makeToken = async function(hours) {

    let token = uuid.v4();

    await sqlQuery(
        "INSERT INTO tblTokens (token, expires) VALUES (?, TIMESTAMP(now() + INTERVAL ? HOUR));",
        [token, hours]
    );

    this.token = token;
    return token;

}

User.fromCredentials = async function(uname, pword) {

    let user_Q = await sqlQuery("SELECT * FROM tblUsers WHERE uName = ?;", [uname]);
    if (user_Q.length !== 1) {
        return null;
    }

    let hash = user_Q[0].uHash;
    let correct = await bcrypt.compare(pword, hash);

    if (!correct) {
        return null;
    } else {
        return new User(user_Q[0].uID, user_Q[0].uPerm);
    }

}

User.fromToken = async function(token) {

    if (!token) {
        throw { code: 20 };
    }

    let uID_Q = await sqlQuery("SELECT uID FROM tblTokens WHERE token = ? AND expires > CURRENT_TIMESTAMP();", [token]);

    if (uID_Q.length !== 1) {
        return null;
    }

    let uID = uID_Q[0].uID;
    let perm_Q = await sqlQuery("SELECT uPerm FROM tblUsers WHERE uID = ?", [uID]);

    if (perm_Q.length !== 1) {
        return null;
    }

    let perm = perm_Q[0].uPerm;

    return new User(uID, perm, token);

}

module.exports=User;