const webpack = require("webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const SpeedMeasurePlugin = require("../../..");
const smp = new SpeedMeasurePlugin();
const path = require('path');

class Plugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("Plugin", (compilation) => {
      const now = Date.now()
      while(Date.now() - now < 2000) {
          continue
      }
    });

    compiler.hooks.emit.tapAsync(
      'HelloAsyncPlugin',
      (compilation, callback) => {
        // 执行某些异步操作...
        setTimeout(function () {
          callback();
        }, 1000);
      }
    );
  }
}

const options = {
  entry: {
    bundle: ["./app.js"],
  },
  output: {
    path: __dirname + "/dist",
  },
  plugins: [
    new webpack.DefinePlugin({ FOO: "'BAR'" }),
    new Plugin(),
    new MiniCssExtractPlugin(),
    // new webpack.debug.ProfilingPlugin({outputPath: require('path').join(__dirname, 'profiling/profileEvents.json'),})
  ],
  module: {
    rules: [
      {
        test: /\.js?$/,
        use: ["babel-loader"],
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
};

// module.exports = options;

module.exports = smp.wrap(options);
