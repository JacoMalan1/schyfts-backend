import { sqlQuery } from './sql.js';
import * as bcrypt from 'bcrypt';
import * as uuid from 'uuid';

export const saltRounds = 10;
export const TOKEN_FORMAT = /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/g;

export class User {
    public id: number;
    public perm: number;
    public token: string;

    constructor(id: number, perm: number, token?: string) {
        this.id = id;
        this.perm = perm;
        this.token = token;
    }

    loggedIn(): boolean {
        return (this.token != null);
    }

    async makeToken(hours: number): Promise<string> {
        let token = uuid.v4();

        await sqlQuery(
            "INSERT INTO tblTokens (token, expires) VALUES (?, TIMESTAMP(now() + INTERVAL ? HOUR));",
            [token, hours]
        );

        this.token = token;
        return token;
    }

    static async register(uname: string, email: string, pword: string, perm: number) {
        let user_Q = await sqlQuery(
            "SELECT uName, uEmail, FROM tblUsers WHERE uName = ? OR uEmail = ?;",
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
        let id: number = id_Q[0].uID;
        let user = new User(id, perm);
        return await user.makeToken(8);
    }

    static async fromToken(token: string): Promise<User> {
        if (!token || !token.match(TOKEN_FORMAT)) {
            throw {message: "Invalid Token"}
        }

        let uID_Q = await sqlQuery("SELECT uID FROM tblTokens WHERE token = ? AND expires > CURRENT_TIMESTAMP();", [token]);
        if (uID_Q.length !== 1) {
            return null;
        }

        let uID: number = uID_Q[0].uID;
        let perm_Q = await sqlQuery("SELECT uPerm FROM tblUsers WHERE uID = ?", [uID]);
        if (perm_Q.length !== 1) {
            return null;
        }

        let perm: number = perm_Q[0].uPerm

        return new User(uID, perm, token);
    }
}