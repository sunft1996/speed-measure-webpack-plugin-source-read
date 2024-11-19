### 问题一：为什么模块很小但是某个阶段的loader转化耗时很高？

已知`/xxx/node_modules/some-package/lib/index.css`只有几行css代码，但是根据输出的json发现`["mini-css-extract-plugin", "css-loader", "postcss-loader"]`处理了 8951ms

 - webpack内部处理模块是由异步队列并发处理的，因此在`mini-css-extract-plugin`中遇到异步工作时，会先处理队列中剩余的所有任务，没有减掉并发处理的模块耗时）
 - 此外`mini-css-extract-plugin`内部创建了一个`子compiler`来编译css，因此也存在一定开销


```JSON
 [
    {
       "averages": { "dataPoints": 69, "median": 1521, "mean": 3036 },
       "activeTime": 18105,
       "loaders": ["mini-css-extract-plugin", "css-loader", "postcss-loader"],
       "subLoadersTime": {},
       "rawStartEnds": [
           {
           "name": "/xxx/node_modules/some-package/lib/index.css",
           "resource": "/xxx/node_modules/some-package/lib/index.css",
           "identifier": "/xxx/node_modules/mini-css-extract-plugin/dist/loader.js!/xxx/node_modules/css-loader/dist/cjs.js??ref--4-oneOf-1-1!/xxx/node_modules/postcss-loader/dist/cjs.js??ref--4-oneOf-1-2!/xxx/node_modules/some-package/lib/index.css",
           "fillLast": true,
           "loaders": [
               "mini-css-extract-plugin",
               "css-loader",
               "postcss-loader"
           ],
           "start": 1690871556485,
           "end": 1690871565436
           }
       ]
    },
    {
        "averages": { "dataPoints": 69, "median": 1514, "mean": 3025 },
        "activeTime": 18087,
        "loaders": ["css-loader", "postcss-loader"],
        "subLoadersTime": {},
        "rawStartEnds": [
            {
            "name": "/xxx/node_modules/css-loader/dist/cjs.js??ref--4-oneOf-1-1!/xxx/node_modules/postcss-loader/dist/cjs.js??ref--4-oneOf-1-2!/xxx/node_modules/some-package/lib/index.css",
            "resource": "/xxx/node_modules/some-package/lib/index.css",
            "identifier": "/xxx/node_modules/css-loader/dist/cjs.js??ref--4-oneOf-1-1!/xxx/node_modules/postcss-loader/dist/cjs.js??ref--4-oneOf-1-2!/xxx/node_modules/some-package/lib/index.css",
            "fillLast": true,
            "loaders": ["css-loader", "postcss-loader"],
            "start": 1690871556653,
            "end": 1690871565431
            }
        ]
    }
]
```

### 问题二：同一个资源会存在多次css-loader处理？

如：`["mini-css-extract-plugin","css-loader"]`, `["css-loader"]`

`mini-css-extract-plugin`内部:

```js
  const loaders = this.loaders.slice(this.loaderIndex + 1);
  // 将当前 CSS 文件添加为依赖
  this.addDependency(this.resourcePath);
```

此外，loader的转化结果为：
```JS
/******/ var __webpack_exports__ = __webpack_require__("./node_modules/css-loader/dist/cjs.js!./test/style.css");
/******/ module.exports = __webpack_exports__;
```
