const MS_IN_MINUTE = 60000;
const MS_IN_SECOND = 1000;

const chalk = require("chalk");
const { fg, bg } = require("./colours");
const { groupBy, getAverages, getTotalActiveTime } = require("./utils");

const humanTime = (ms, options = {}) => {
  if (options.verbose) {
    return ms.toLocaleString() + " ms";
  }

  const minutes = Math.floor(ms / MS_IN_MINUTE);
  const secondsRaw = (ms - minutes * MS_IN_MINUTE) / MS_IN_SECOND;
  const secondsWhole = Math.floor(secondsRaw);
  const remainderPrecision = secondsWhole > 0 ? 2 : 3;
  const secondsRemainder = Math.min(secondsRaw - secondsWhole, 0.99);
  const seconds =
    secondsWhole +
    secondsRemainder
      .toPrecision(remainderPrecision)
      .replace(/^0/, "")
      .replace(/0+$/, "")
      .replace(/^\.$/, "");

  let time = "";

  if (minutes > 0) time += minutes + " min" + (minutes > 1 ? "s" : "") + ", ";
  time += seconds + " secs";

  return time;
};

const smpTag = () => bg(" SMP ") + " ⏱  ";
module.exports.smpTag = smpTag;

module.exports.getHumanOutput = (outputObj, options = {}) => {
  const hT = (x) => humanTime(x, options);
  let output = "\n\n" + smpTag() + "\n";

  if (outputObj.misc) {
    output +=
      "General output time took " +
      fg(hT(outputObj.misc.compileTime, options), outputObj.misc.compileTime);
    output += "\n\n";
  }
  if (outputObj.plugins) {
    output += smpTag() + "Plugins\n";
    Object.keys(outputObj.plugins)
      .sort(
        (name1, name2) => outputObj.plugins[name2] - outputObj.plugins[name1]
      )
      .forEach((pluginName) => {
        output +=
          chalk.bold(pluginName) +
          " took " +
          fg(hT(outputObj.plugins[pluginName]), outputObj.plugins[pluginName]);
        output += "\n";
      });
    output += "\n";
  }
  if (outputObj.loaders) {
    output += smpTag() + "Loaders\n";
    outputObj.loaders.build
      .sort((obj1, obj2) => obj2.activeTime - obj1.activeTime)
      .forEach((loaderObj) => {
        output +=
          loaderObj.loaders.map(fg).join(", and \n") +
          " took " +
          fg(hT(loaderObj.activeTime), loaderObj.activeTime) +
          "\n";

        let xEqualsY = [];
        if (options.verbose) {
          xEqualsY.push(["median", hT(loaderObj.averages.median)]);
          xEqualsY.push(["mean", hT(loaderObj.averages.mean)]);
          if (typeof loaderObj.averages.variance === "number")
            xEqualsY.push(["s.d.", hT(Math.sqrt(loaderObj.averages.variance))]);
          xEqualsY.push([
            "range",
            "(" +
              hT(loaderObj.averages.range.start) +
              " --> " +
              hT(loaderObj.averages.range.end) +
              ")",
          ]);
        }

        if (loaderObj.loaders.length > 1) {
          Object.keys(loaderObj.subLoadersTime).forEach((subLoader) => {
            xEqualsY.push([subLoader, hT(loaderObj.subLoadersTime[subLoader])]);
          });
        }

        xEqualsY.push(["module count", loaderObj.averages.dataPoints]);

        if (options.loaderTopFiles) {
          const loopLen = Math.min(
            loaderObj.rawStartEnds.length,
            options.loaderTopFiles
          );
          for (let i = 0; i < loopLen; i++) {
            const rawItem = loaderObj.rawStartEnds[i];
            xEqualsY.push([rawItem.name, hT(rawItem.end - rawItem.start)]);
          }
        }

        const maxXLength = xEqualsY.reduce(
          (acc, cur) => Math.max(acc, cur[0].length),
          0
        );
        xEqualsY.forEach((xY) => {
          const padEnd = maxXLength - xY[0].length;
          output += "  " + xY[0] + " ".repeat(padEnd) + " = " + xY[1] + "\n";
        });
      });
  }

  output += "\n\n";

  return output;
};

module.exports.getMiscOutput = (data) => ({
  compileTime: data.compile[0].end - data.compile[0].start,
});

module.exports.getPluginsOutput = (data) =>
  Object.keys(data).reduce((acc, key) => {
    const inData = data[key];

    const startEndsByName = groupBy("name", inData);

    return startEndsByName.reduce((innerAcc, startEnds) => {
      innerAcc[startEnds[0].name] =
        (innerAcc[startEnds[0].name] || 0) + getTotalActiveTime(startEnds);
      return innerAcc;
    }, acc);
  }, {});

/**
 * @typedef {Object} BuildItem
 * @property {string} name 模块路径：module.userRequest
 * @property {number} loaders module.build触发时的module.loaders
 * @property {string} start 开始转化时间
 * @property {string} end 结束转化时间
 * @property {string} fillLast 
 */

/**
 * @typedef {Object} BuildSpecificItem
 * @property {string} name 模块路径：loader context中的resourcePath，同个有可能会重复
 * @property {number} id 
 * @property {number} loader 负责转化的loader 
 * @property {string} start 开始转化时间
 * @property {string} end 结束转化时间
 */

/**
 * @typedef {Object} DataObject
 * @property {BuildItem[]} build - 所有module.build时记录的loader转化信息
 * @property {BuildSpecificItem[]} `build-specific` - 所有单个loader转化的信息
 */

/**
 * @param {DataObject} data
 * @returns {*}
 */

module.exports.getLoadersOutput = (data) => {
  // 按照Loaders分类
  const startEndsByLoader = groupBy("loaders", data.build);
  const allSubLoaders = data["build-specific"] || [];

  const buildData = startEndsByLoader.map((startEnds) => {
    // 计算每组Loader的平均耗时
    const averages = getAverages(startEnds);
    // 总耗时
    const activeTime = getTotalActiveTime(startEnds);
    // 找到allSubLoaders中，转化过相同模块的 所有loader处理数据，并按照Loader分组
    const subLoaders = groupBy(
      "loader",
      allSubLoaders.filter((l) => startEnds.find((x) => x.name === l.name))
    );
    // 计算subLoader中，各组loader的处理时长
    const subLoadersActiveTime = subLoaders.reduce((acc, loaders) => {
      acc[loaders[0].loader] = getTotalActiveTime(loaders);
      return acc;
    }, {});

    return {
      averages,
      activeTime,
      loaders: startEnds[0].loaders,
      // 转化过相同模块的所有subLoader中，各组loader的处理时长
      subLoadersTime: subLoadersActiveTime,
      rawStartEnds: startEnds.sort(
        (a, b) => b.end - b.start - (a.end - a.start)
      ),
    };
  });

  return { build: buildData };
};
