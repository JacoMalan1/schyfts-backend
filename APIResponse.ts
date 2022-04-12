export class APIResponse {
    private status: string;
    private message: string;

    constructor(status: boolean, message: string) {
        this.status = (status) ? "ok" : "error";
        this.message = message;
    }
}