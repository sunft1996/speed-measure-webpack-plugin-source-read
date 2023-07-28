/**
 * 耗时计算：
 * 
 * loader思路：
 *  方法一：插件监听build-module、succeed-module hook，记录module、module.loaders、以及时间差；
 *  方法二：
 *      1. 插件监听normal-module-loader，在loader context挂载【时间记录函数】
 *      2. 给配置中的所有loader前添加一个loader，在pitch方法中（第一个Loader的pitch一定会第一个执行），
 *            hack require方法，如果require某一个loader，给当前loader加上时间记录的逻辑
 * 
 * plugin思路：
 *  hack插件的apply方法，当组件调用apply绑定时，对compiler新建proxy，如果调用hooks.tap(callback)，给callback包裹时间记录的逻辑
 *  缺点：对compiler以及它的很多属性都设置了proxy，导致一些plugin内部需要origin proxy时，拿到的都是proxy对象，造成bug，webpack5时尤其明显，因此不建议这种方案
 * 
 * 总时间 = done hook - compile hook
 * 
 */

const path = require("path");
const fs = require("fs");
const chalk = require("chalk");
const { WrappedPlugin, clear } = require("./WrappedPlugin");
const {
  getModuleName,
  getLoaderNames,
  prependLoader,
  tap,
} = require("./utils");
const {
  getHumanOutput,
  getMiscOutput,
  getPluginsOutput,
  getLoadersOutput,
  smpTag,
} = require("./output");

const NS = path.dirname(fs.realpathSync(__filename));

module.exports = class SpeedMeasurePlugin {
  constructor(options) {
    this.options = options || {};

    this.timeEventData = {};
    this.smpPluginAdded = false;

    this.wrap = this.wrap.bind(this);
    this.getOutput = this.getOutput.bind(this);
    this.addTimeEvent = this.addTimeEvent.bind(this);
    this.apply = this.apply.bind(this);
    this.provideLoaderTiming = this.provideLoaderTiming.bind(this);
    this.generateLoadersBuildComparison = this.generateLoadersBuildComparison.bind(
      this
    );
  }

  /**
   * 对 webpack 配置进行包装处理
   */  
  wrap(config) {
    if (this.options.disable) return config;
    if (Array.isArray(config)) return config.map(this.wrap);
    if (typeof config === "function")
      return (...args) => this.wrap(config(...args));

    // 包装插件
    config.plugins = (config.plugins || []).map((plugin) => {
      const pluginName =
        Object.keys(this.options.pluginNames || {}).find(
          (pluginName) => plugin === this.options.pluginNames[pluginName]
        ) ||
        (plugin.constructor && plugin.constructor.name) ||
        "(unable to deduce plugin name)";
      return new WrappedPlugin(plugin, pluginName, this);
    });

    // 包装优化器中的插件
    if (config.optimization && config.optimization.minimizer) {
      config.optimization.minimizer = config.optimization.minimizer.map(
        (plugin) => {
          return new WrappedPlugin(plugin, plugin.constructor.name, this);
        }
      );
    }

    // 在模块中预处理loader
    if (config.module && this.options.granularLoaderData) {
      config.module = prependLoader(config.module);
    }

    // 将该插件也添加到配置中
    if (!this.smpPluginAdded) {
      config.plugins = config.plugins.concat(this);
      this.smpPluginAdded = true;
    }

    return config;
  }

  /**
   * 生成loader构建比较的报告
   */  
  generateLoadersBuildComparison() {
    const objBuildData = { loaderInfo: [] };
    const loaderFile = this.options.compareLoadersBuild.filePath;
    const outputObj = getLoadersOutput(this.timeEventData.loaders);

    if (!loaderFile) {
      throw new Error(
        "`options.compareLoadersBuild.filePath` is a required field"
      );
    }

    if (!outputObj) {
      throw new Error("No output found!");
    }

    // 读取之前的构建信息
    const buildDetailsFile = fs.existsSync(loaderFile)
      ? fs.readFileSync(loaderFile)
      : "[]";
    const buildDetails = JSON.parse(buildDetailsFile.toString());
    const buildCount = buildDetails.length;
    const buildNo =
      buildCount > 0 ? buildDetails[buildCount - 1]["buildNo"] + 1 : 1;

    // 创建当前构建的loader信息
    // create object format of current loader and write in the file
    outputObj.build.forEach((loaderObj) => {
      const loaderInfo = {};
      loaderInfo["Name"] = loaderObj.loaders.join(",") || "";
      loaderInfo["Time"] = loaderObj.activeTime || "";
      loaderInfo["Count"] =
        this.options.outputFormat === "humanVerbose"
          ? loaderObj.averages.dataPoints
          : "";
      loaderInfo[`Comparison`] = "";

      // 获取与之前构建的loader耗时进行比较的信息
      // Getting the comparison from the previous build by default only
      // in case if build data is more then one
      if (buildCount > 0) {
        const prevBuildIndex = buildCount - 1;
        for (
          var y = 0;
          y < buildDetails[prevBuildIndex]["loaderInfo"].length;
          y++
        ) {
          const prevloaderDetails =
            buildDetails[prevBuildIndex]["loaderInfo"][y];
          if (
            loaderInfo["Name"] == prevloaderDetails["Name"] &&
            prevloaderDetails["Time"]
          ) {
            const previousBuildTime =
              buildDetails[prevBuildIndex]["loaderInfo"][y]["Time"];
            const savedTime = previousBuildTime > loaderObj.activeTime;

            // 比较loader耗时，并标记为更快或更慢
            loaderInfo[`Comparison`] = `${savedTime ? "-" : "+"}${Math.abs(
              loaderObj.activeTime - previousBuildTime
            )}ms | ${savedTime ? "(slower)" : "(faster)"}`;
          }
        }
      }

      objBuildData["loaderInfo"].push(loaderInfo);
    });

    // 将当前构建的loader信息写入文件
    buildDetails.push({ buildNo, loaderInfo: objBuildData["loaderInfo"] });

    fs.writeFileSync(loaderFile, JSON.stringify(buildDetails));

    // 打印loader构建比较的报告
    for (let i = 0; i < buildDetails.length; i++) {
      const outputTable = [];
      console.log("--------------------------------------------");
      console.log("Build No ", buildDetails[i]["buildNo"]);
      console.log("--------------------------------------------");

      if (buildDetails[i]["loaderInfo"]) {
        buildDetails[i]["loaderInfo"].forEach((buildInfo) => {
          const objCurrentBuild = {};
          objCurrentBuild["Name"] = buildInfo["Name"] || "";
          objCurrentBuild["Time (ms)"] = buildInfo["Time"] || "";
          if (this.options.outputFormat === "humanVerbose")
            objCurrentBuild["Count"] = buildInfo["Count"] || 0;
          objCurrentBuild["Comparison"] = buildInfo["Comparison"] || "";
          outputTable.push(objCurrentBuild);
        });
      }
      console.table(outputTable);
    }
  }

  /**
   * 根据配置返回输出的报告
   */  
  getOutput() {
    const outputObj = {};
    if (this.timeEventData.misc)
      outputObj.misc = getMiscOutput(this.timeEventData.misc);
    if (this.timeEventData.plugins)
      outputObj.plugins = getPluginsOutput(this.timeEventData.plugins);
    if (this.timeEventData.loaders)
      outputObj.loaders = getLoadersOutput(this.timeEventData.loaders);

    if (this.options.outputFormat === "json")
      return JSON.stringify(outputObj, null, 2);
    if (typeof this.options.outputFormat === "function")
      return this.options.outputFormat(outputObj);
    return getHumanOutput(
      outputObj,
      Object.assign(
        { verbose: this.options.outputFormat === "humanVerbose" },
        this.options
      )
    );
  }

  /**
   * 添加时间事件
   */  
  addTimeEvent(category, event, eventType, data = {}) {
    const allowFailure = data.allowFailure;
    delete data.allowFailure;

    const tED = this.timeEventData;
    if (!tED[category]) tED[category] = {};
    if (!tED[category][event]) tED[category][event] = [];
    const eventList = tED[category][event];
    const curTime = new Date().getTime();

    if (eventType === "start") {
      data.start = curTime;
      eventList.push(data);
    } else if (eventType === "end") {
      // 查找匹配的事件，根据 ID 或名称匹配
      const matchingEvent = eventList.find((e) => {
        const allowOverwrite = !e.end || !data.fillLast;
        const idMatch = e.id !== undefined && e.id === data.id;
        const nameMatch =
          !data.id && e.name !== undefined && e.name === data.name;
        return allowOverwrite && (idMatch || nameMatch);
      });
      const eventToModify =
        matchingEvent || (data.fillLast && eventList.find((e) => !e.end));
      if (!eventToModify) {
        console.error(
          "Could not find a matching event to end",
          category,
          event,
          data
        );
        if (allowFailure) return;
        throw new Error("No matching event!");
      }

      eventToModify.end = curTime;
    }
  }

  /**
   * 将speed-measure-plugin插件应用于 webpack
   * @param {*} compiler
   * @returns {*}
   */  
  apply(compiler) {
    if (this.options.disable) return;

    // 监听编译开始事件
    tap(compiler, "compile", () => {
      this.addTimeEvent("misc", "compile", "start", { watch: false });
    });
    // 监听编译完成事件
    tap(compiler, "done", () => {
      clear();
      this.addTimeEvent("misc", "compile", "end", { fillLast: true });

      const outputToFile = typeof this.options.outputTarget === "string";
      chalk.enabled = !outputToFile;
      const output = this.getOutput();
      chalk.enabled = true;
      // 将报告输出到文件
      if (outputToFile) {
        const writeMethod = fs.existsSync(this.options.outputTarget)
          ? fs.appendFileSync
          : fs.writeFileSync;
        writeMethod(this.options.outputTarget, output + "\n");
        console.log(
          smpTag() + "Outputted timing info to " + this.options.outputTarget
        );
      } else {
        // 输出报告
        const outputFunc = this.options.outputTarget || console.log;
        outputFunc(output);
      }

      if (this.options.compareLoadersBuild)
        // 生成loader构建比较的报告
        this.generateLoadersBuildComparison();

      this.timeEventData = {};
    });

    // 监听编译阶段事件
    tap(compiler, "compilation", (compilation) => {
      // 监听normal-module-loader事件，记录loader的耗时
      // 注：webpack5已废弃
      tap(compilation, "normal-module-loader", (loaderContext) => {
        loaderContext[NS] = this.provideLoaderTiming;
      });

      // TODO: webpack5以上
      // NormalModule.getCompilationHooks(compilation).loader.tap("SpeedMeasureWebpackPlugin", (loaderContext) => {
      //   loaderContext[NS] = this.provideLoaderTiming;
      // });

      // 监听构建模块事件，记录loader构建的开始
      tap(compilation, "build-module", (module) => {
        const name = getModuleName(module);
        if (name) {
          this.addTimeEvent("loaders", "build", "start", {
            name,
            fillLast: true,
            loaders: getLoaderNames(module.loaders),
          });
        }
      });

      // 监听成功构建模块事件，记录loader构建的结束
      // TODO: speed-measure-plugin只能统计出css-loader style-loader等一起转化的时间？ 错，都可以统计，看normal-module-loader
      tap(compilation, "succeed-module", (module) => {
        const name = getModuleName(module);
        if (name) {
          this.addTimeEvent("loaders", "build", "end", {
            name,
            fillLast: true,
          });
        }
      });
    });
  }

  /**
   * 提供loader的耗时信息
   */  
  provideLoaderTiming(info) {
    const infoData = { id: info.id };
    if (info.type !== "end") {
      infoData.loader = info.loaderName;
      infoData.name = info.module;
    }

    this.addTimeEvent("loaders", "build-specific", info.type, infoData);
  }
};
