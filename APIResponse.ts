export class APIResponse {
    private status: string;
    private message: string;

    constructor(status: boolean, message: string, extra?: any) {
        this.status = (status) ? "ok" : "error";
        this.message = message;

        if (extra) {
            for (let key of Object.keys(extra)) {
                this[key] = extra[key];
            }
        }
    }
}