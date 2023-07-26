/**
 * speed-measure-plugin配套的loader
 * 会自动加在所有loader列表前面
 * 它会hack require方法，如果require某一个loader，会给loader加上时间记录的逻辑
 */
const path = require("path");
const fs = require("fs");
const { hackWrapLoaders } = require("./utils");

let id = 0;

const NS = path.dirname(fs.realpathSync(__filename));

const getLoaderName = (path) => {
  const standardPath = path.replace(/\\/g, "/");
  const nodeModuleName = /\/node_modules\/([^\/]+)/.exec(standardPath);
  return (nodeModuleName && nodeModuleName[1]) || "";
};
// pitch执行顺序：loaderA、loaderB、loaderC
// loaderC.pitch => loaderB.pitch => loaderA.pitch
// loaderA.normal => loaderB.normal => loaderC.normal

module.exports.pitch = function () {
  const callback = this[NS];
  const module = this.resourcePath;
  const loaderPaths = this.loaders
    .map((l) => l.path)
    .filter((l) => !l.includes("speed-measure-webpack-plugin"));

  // hack loader，给所有Loader加上时间记录逻辑
  // Hack ourselves to overwrite the `require` method so we can override the
  // loadLoaders
  hackWrapLoaders(loaderPaths, (loader, path) => {
    const loaderName = getLoaderName(path);
    const wrapFunc = (func) =>
      function () {
        const loaderId = id++;
        const almostThis = Object.assign({}, this, {
          // 重写this.async方法，loader中使用this.async告诉loader-runner是一个异步loader
          // this.async会返回一个this.callback
          async: function () {
            const asyncCallback = this.async.apply(this, arguments);

            // hack this.async中的this.callback
            return function () {
              // 先记录时间
              callback({
                id: loaderId,
                type: "end",
              });
              // 在调用this.callback
              return asyncCallback.apply(this, arguments);
            };
          }.bind(this),
        });
        // 统计loader开始转化时间 
        callback({
          module,
          loaderName,
          id: loaderId,
          type: "start",
        });
        // 执行Loader
        const ret = func.apply(almostThis, arguments);
        // 统计Loader结束时间
        callback({
          id: loaderId,
          type: "end",
        });
        return ret;
      };

    if (loader.normal) loader.normal = wrapFunc(loader.normal);
    if (loader.default) loader.default = wrapFunc(loader.default);
    if (loader.pitch) loader.pitch = wrapFunc(loader.pitch);
    if (typeof loader === "function") return wrapFunc(loader);
    return loader;
  });
};
