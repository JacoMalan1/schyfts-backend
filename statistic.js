class Statistic {
    constructor() {
        this.weekdayCalls = [0, 0, 0];
        this.weekendCalls = [0, 0, 0];
        this.christmasCalls = [0, 0, 0];
        this.newYearCalls = [0, 0, 0];
        this.holidayCalls = [0, 0, 0];
        this.easterCalls = [0, 0, 0];
    }

    addEasterCall(value) {
        this.easterCalls[value - 1]++;
        this.addHolidayCall(value);
    }

    addWeekdayCall(value) {
        this.weekdayCalls[value - 1]++;
    }

    addWeekendCall(value) {
        this.weekendCalls[value - 1]++;
    }

    addChristmasCall(value) {
        this.christmasCalls[value - 1]++;
        this.addHolidayCall(value);
    }

    addNewYearCall(value) {
        this.newYearCalls[value - 1]++;
        this.addHolidayCall(value);
    }

    addHolidayCall(value) {
        this.holidayCalls[value - 1]++;
    }

    getTableRow(doctorName) {
        let result = `<tr><td>${doctorName}</td>`;
        let td = '<td style="text-align:center">'

        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekdayCalls[i].toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekendCalls[i].toString()}</td>`
        for (let i = 0; i < 3; i++)
            result += `${td}${this.holidayCalls[i].toString()}</td>`;;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.easterCalls[i].toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.christmasCalls[i].toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.newYearCalls[i].toString()}</td>`;

        result += '</tr>';

        return result;
    }

    static getTableHeader() {
        let result = '<tr><th>Doctor</th>';
        let th = '<th style="text-align:center">';

        for (let i = 0; i < 3; i++)
            result += `${th}Call ${i + 1}</th>`;
        for (let i = 0; i < 3; i++)
            result += `${th}Weekend Call ${i + 1}</th>`;
        for (let i = 0; i < 3; i++)
            result += `${th}Holiday Call ${i + 1}</th>`;
        for (let i = 0; i < 3; i++)
            result += `${th}Easter Call ${i + 1}</th>`;
        for (let i = 0; i < 3; i++)
            result += `${th}XMas Call ${i + 1}</th>`;
        for (let i = 0; i < 3; i++)
            result += `${th}New Year Call ${i + 1}</th>`;

        result += '</tr>';

        return result;
    }

    getTotalRow() {
        let result = `<tr><td>TOTAL:</td>`;
        let td = '<td style="text-align:center">'

        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekdayCalls[i].toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekendCalls[i].toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.holidayCalls[i].toString()}</td>`;

        result += '</tr>';

        return result;
    }

    getAverageRow() {
        let result = `<tr><td>Avg:</td>`;
        let td = '<td style="text-align:center">'

        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekdayCalls[i].toFixed(2).toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.weekendCalls[i].toFixed(2).toString()}</td>`;
        for (let i = 0; i < 3; i++)
            result += `${td}${this.holidayCalls[i].toFixed(2).toString()}</td>`;

        result += '</tr>';

        return result;
    }
}

module.exports = Statistic