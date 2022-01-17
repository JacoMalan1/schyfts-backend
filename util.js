function strToIntArr(strArr) {
    let split = strArr.split(",");
    let intArr = [];
    for (let s of split) {
        intArr.push(parseInt(s))
    }
    return intArr;
}

module.exports = strToIntArr;