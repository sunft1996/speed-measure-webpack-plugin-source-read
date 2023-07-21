let idInc = 0;

/**
 * 生成包装函数：函数会在执行目标函数之前和之后添加时间事件
 * 只有 tap、tapAsync、tapPromise、compiler.plugin()会被包装
 * @returns {*}
 */
const genWrappedFunc = ({
  func,
  smp,
  context,
  timeEventName,
  pluginName,
  endType,
}) => (...args) => {
  const id = idInc++;
  // 添加开始事件
  // we don't know if there's going to be a callback applied to a particular
  // call, so we just set it multiple times, letting each one override the last
  const addEndEvent = () =>
    smp.addTimeEvent("plugins", timeEventName, "end", {
      id,
      // we need to allow failure, since webpack can finish compilation and
      // cause our callbacks to fall on deaf ears
      allowFailure: true,
    });

  smp.addTimeEvent("plugins", timeEventName, "start", {
    id,
    name: pluginName,
  });
  // 立即触发一个结束事件，以防回调函数导致 webpack 完成编译
  // invoke an end event immediately in case the callback here causes webpack
  // to complete compilation. If this gets invoked and not the subsequent
  // call, then our data will be inaccurate, sadly
  addEndEvent();
  // 我的优化项一：
  // 对函数的每个参数 进行proxy
  const normalArgMap = a => wrap(a, pluginName, smp);
  // 对hooks tap的参数不要生成proxy，比如compilation
  // const normalArgMap = a => a

  // 根据函数不同的类型包装函数
  let ret;
  if (endType === "wrapDone")
    ret = func.apply(
      context,
      args.map(a => wrap(a, pluginName, smp, addEndEvent))
    );
  else if (endType === "async") {
    const argsButLast = args.slice(0, args.length - 1);
    const callback = args[args.length - 1];
    ret = func.apply(
      context,
      argsButLast.map(normalArgMap).concat((...callbackArgs) => {
        addEndEvent();
        callback(...callbackArgs);
      })
    );
  } else if (endType === "promise")
    ret = func.apply(context, args.map(normalArgMap)).then(promiseArg => {
      addEndEvent();
      return promiseArg;
    });
  else ret = func.apply(context, args.map(normalArgMap));
  // 添加结束事件
  addEndEvent();

  return ret;
};

/**
 * webpack3支持
 * @returns {*}
 */
const genPluginMethod = (orig, pluginName, smp, type) =>
  function(method, func) {
    const timeEventName = pluginName + "/" + type + "/" + method;
    // 添加时间事件
    const wrappedFunc = genWrappedFunc({
      func,
      smp,
      context: this,
      timeEventName,
      pluginName,
      endType: "wrapDone",
    });
    return orig.plugin(method, wrappedFunc);
  };

// 包装tap方法
const wrapTap = (tap, pluginName, smp, type, method) =>
  function(id, func) {
    const timeEventName = pluginName + "/" + type + "/" + method;
    // 把tap的callback进行包装，添加时间记录
    const wrappedFunc = genWrappedFunc({
      // tap的回调函数
      func,
      smp,
      context: this,
      timeEventName,
      pluginName,
    });
    return tap.call(this, id, wrappedFunc);
  };

const wrapTapAsync = (tapAsync, pluginName, smp, type, method) =>
  function(id, func) {
    const timeEventName = pluginName + "/" + type + "/" + method;
    const wrappedFunc = genWrappedFunc({
      func,
      smp,
      context: this,
      timeEventName,
      pluginName,
      endType: "async",
    });
    // this为hook proxy，id是插件名称
    return tapAsync.call(this, id, wrappedFunc);
  };

const wrapTapPromise = (tapPromise, pluginName, smp, type, method) =>
  function(id, func) {
    const timeEventName = pluginName + "/" + type + "/" + method;
    const wrappedFunc = genWrappedFunc({
      func,
      smp,
      context: this,
      timeEventName,
      pluginName,
      endType: "promise",
    });
    return tapPromise.call(this, id, wrappedFunc);
  };

const wrappedHooks = [];

// 包装hooks
const wrapHooks = (orig, pluginName, smp, type) => {
  const hooks = orig.hooks;
  if (!hooks) return hooks;
  const prevWrapped = wrappedHooks.find(
    w =>
      w.pluginName === pluginName && (w.orig === hooks || w.wrapped === hooks)
  );
  if (prevWrapped) return prevWrapped.wrapped;

  const genProxy = method => {
    const proxy = new Proxy(hooks[method], {
      get: (target, property) => {
        const raw = Reflect.get(target, property);

        if (Object.isFrozen(target)) {
          return raw;
        }

        if (property === "tap" && typeof raw === "function")
          return wrapTap(raw, pluginName, smp, type, method).bind(proxy);
        if (property === "tapAsync" && typeof raw === "function")
          return wrapTapAsync(raw, pluginName, smp, type, method).bind(proxy);
        if (property === "tapPromise" && typeof raw === "function")
          return wrapTapPromise(raw, pluginName, smp, type, method).bind(proxy);

        return raw;
      },
      set: (target, property, value) => {
        return Reflect.set(target, property, value);
      },
      deleteProperty: (target, property) => {
        return Reflect.deleteProperty(target, property);
      },
    });
    return proxy;
  };
  // 对每个hook进行hack
  const wrapped = Object.keys(hooks).reduce((acc, method) => {
  // 对tap tapAsync tapPromise进行代理，然后用之前的genWrappedFunc添加时间事件
    acc[method] = genProxy(method);
    return acc;
  }, {});

  wrappedHooks.push({ orig: hooks, wrapped, pluginName });

  return wrapped;
};

const construcNamesToWrap = [
  "Compiler",
  "Compilation",
  "MainTemplate",
  "Parser",
  "NormalModuleFactory",
  "ContextModuleFactory",
];

const wrappedObjs = [];
// 查找插件是否被包装过
const findWrappedObj = (orig, pluginName) => {
  const prevWrapped = wrappedObjs.find(
    w => w.pluginName === pluginName && (w.orig === orig || w.wrapped === orig)
  );
  if (prevWrapped) return prevWrapped.wrapped;
};

/**
 * 通用的包装函数，会自行决定某个属性是否需要包装：包含hooks、plugins等
 * 它会检查某个属性是否已经被包装过，如果已经包装过，则直接返回已包装的对象；
 * 如果没有被包装过，则创建一个Proxy，并将原始对象和代理对象的映射关系存储在 wrappedObjs 数组中。
 * @param {*} orig compiler
 * @param {*} pluginName 表示插件的名称，用于标识插件在包装过程中的相关信息。
 * @param {*} smp 表示 SpeedMeasurePlugin 的实例，用于添加时间事件和跟踪耗时。
 * @param {*} addEndEvent 一个函数，用于添加结束事件，该函数会在适当的时机被调用，以确保时间事件的正确记录。
 * @returns {*} 包装后的对象。
 */
const wrap = (orig, pluginName, smp, addEndEvent) => {
  if (!orig) return orig;
  const prevWrapped = findWrappedObj(orig, pluginName);
  if (prevWrapped) return prevWrapped;

  const getOrigConstrucName = target =>
    target && target.constructor && target.constructor.name;
  const getShouldWrap = target => {
    const origConstrucName = getOrigConstrucName(target);
    return construcNamesToWrap.includes(origConstrucName);
  };
  const shouldWrap = getShouldWrap(orig);
  const shouldSoftWrap = Object.keys(orig)
    .map(k => orig[k])
    .some(getShouldWrap);

  let wrappedReturn;

  if (!shouldWrap && !shouldSoftWrap) {
    const vanillaFunc = orig.name === "next";
    wrappedReturn =
      vanillaFunc && addEndEvent
        ? function() {
            // do this before calling the callback, since the callback can start
            // the next plugin step
            addEndEvent();

            return orig.apply(this, arguments);
          }
        : orig;
  } else {
    // 对compiler新建proxy
    const proxy = new Proxy(orig, {
      get: (target, property) => {
        const raw = Reflect.get(target, property);
        // 调用compiler.plugin('hook', (compliation, data)) webpack3的属性， webpack4 5没有这个属性
        // https://github.com/webpack/webpack/blob/webpack-3/lib/Compiler.js
        if (shouldWrap && property === "plugin")
          return genPluginMethod(
            target,
            pluginName,
            smp,
            getOrigConstrucName(target)
          ).bind(proxy);
        // 调用compiler.hooks.tap
        if (shouldWrap && property === "hooks")
          return wrapHooks(
            target,
            pluginName,
            smp,
            getOrigConstrucName(target)
          );

        if (shouldWrap && property === "compiler") {
          const prevWrapped = findWrappedObj(raw, pluginName);
          if (prevWrapped) {
            return prevWrapped;
          }
        }

        // compiler.webpack()、compiler.logger()等 
        if (typeof raw === "function") {
          const ret = raw.bind(proxy);
          if (property === "constructor")
            Object.defineProperty(ret, "name", {
              value: raw.name,
            });

          // 我的优化项二：
          // mini-css-extract-plugin中会调用 webpack()方法，如果使用以下方法，会导致webpack方法是一个proxy
          // 而loader转化时，也会调用webpack()方法，这时候拿到的是原本的webpack方法，而之前使用wbepack proxy作为key设置了缓存
          // 导致出错
          // 因此我们最好只监听hooks，没人会把hooks作为缓存的key

          const funcProxy = new Proxy(ret, {
            get: (target, property) => {
              return raw[property];
            },
          });
          return funcProxy;
        }

        return raw;
      },
      set: (target, property, value) => {
        return Reflect.set(target, property, value);
      },
      deleteProperty: (target, property) => {
        return Reflect.deleteProperty(target, property);
      },
    });

    wrappedReturn = proxy;
  }

  wrappedObjs.push({ pluginName, orig, wrapped: wrappedReturn });
  return wrappedReturn;
};

module.exports.clear = () => {
  wrappedObjs.length = 0;
  wrappedHooks.length = 0;
};

module.exports.WrappedPlugin = class WrappedPlugin {
  constructor(plugin, pluginName, smp) {
    this._smp_plugin = plugin;
    this._smp_pluginName = pluginName;
    this._smp = smp;

    this.apply = this.apply.bind(this);

    const wp = this;
    return new Proxy(plugin, {
      get(target, property) {
        // hack原插件的apply方法
        if (property === "apply") {
          return wp.apply;
        }
        return target[property];
      },
      set: (target, property, value) => {
        return Reflect.set(target, property, value);
      },
      deleteProperty: (target, property) => {
        return Reflect.deleteProperty(target, property);
      },
    });
  }

  /**
   * 绑定时调用wrap方法，对compiler新建proxy
   */  
  apply(compiler) {
    return this._smp_plugin.apply(
      wrap(compiler, this._smp_pluginName, this._smp)
    );
  }
};
