export function strToIntArr(strArr: string): number[] {
    let split: Array<string> = strArr.split(",");
    let intArr: Array<number> = [];

    for (let s of split) {
        intArr.push(parseInt(s))
    }

    return intArr;
}