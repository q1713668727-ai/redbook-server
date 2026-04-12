var createError = require('http-errors');
var express = require('express');
var cors = require('cors');
var bodyParser = require('body-parser');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const WebSocket = require('ws');
var query = require('./util/dbHelper.js');
var authMiddleware = require('./util/authMiddleware');

var indexRouter = require('./routes/index');
var websocketRouter = require('./routes/websocket');
var fileRouter = require('./routes/file');
var videoRouter = require('./routes/video');
var userRouter = require('./routes/user');
var loginRouter = require('./routes/login.js');

var app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use(function (req, res, next) {
  res.header('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(authMiddleware);

app.use('/', indexRouter);
app.use('/file', fileRouter);
app.use('/video', videoRouter);
app.use('/user', userRouter);
app.use('/login', loginRouter);
app.use('/websocket', websocketRouter);

app.use(function (req, res, next) {
  res.setTimeout(120 * 1000, function () {
    console.log('Request has timed out.');
    return res.status(408).send('Request timeout');
  });
  next();
});

app.use(function (req, res, next) {
  next(createError(404));
});

app.use(function (err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  res.status(err.status || 500);
  res.render('error');
});

const wss = new WebSocket.Server({ port: 8001 });

wss.on('connection', ws => {
  console.log('WebSocket client connected.');

  ws.on('message', msg => {
    let objData;

    try {
      objData = JSON.parse(msg.toString());
    } catch (err) {
      console.log('Invalid WebSocket payload:', err);
      return;
    }

    if (objData && objData.type === 'register' && objData.account) {
      const currentAccount = String(objData.account);
      wss.clients.forEach((client) => {
        if (
          client !== ws &&
          client.readyState === WebSocket.OPEN &&
          String(client.account || '') === currentAccount
        ) {
          try {
            client.send(JSON.stringify({ type: 'kicked', message: 'Your account logged in elsewhere.' }));
          } catch (err) {
            console.log('Kick old client notify failed:', err);
          }
          try {
            client.close(4001, 'kicked');
          } catch (err) {
            console.log('Kick old client close failed:', err);
          }
        }
      });

      ws.account = currentAccount;
      try {
        ws.send(JSON.stringify({ type: 201, message: 'registered' }));
      } catch (err) {
        console.log('Register ack failed:', err);
      }
      return;
    }

    if (!objData || !objData.message || !objData.message.text) {
      console.log('Missing message payload.');
      return;
    }

    if (objData.message.text.type === 'file' && objData.message.text.url) {
      const suffix = objData.message.text.url.split('.');
      objData.message.text.suffix = suffix[suffix.length - 1];
    }

    let targetMessage = { ...objData.message };
    targetMessage.mine = false;
    let targetUserToUser = objData.target + '-' + objData.account;
    let chatData = {
      target: null,
      me: null
    };

    query('SELECT * FROM `msg` WHERE `UserToUser` = ? OR `UserToUser` = ?;', [objData.UserToUser, targetUserToUser])
      .then(result => {
        result.forEach(element => {
          if (element.UserToUser == targetUserToUser) {
            chatData.target = JSON.parse(element.message);
            chatData.target.read = (chatData.target.read || 0) + 1;
            chatData.target.historyMessage = chatData.target.historyMessage || [];
            chatData.target.historyMessage.push(targetMessage);
          } else if (element.UserToUser == objData.UserToUser) {
            chatData.me = JSON.parse(element.message);
            chatData.me.historyMessage = chatData.me.historyMessage || [];
            chatData.me.historyMessage.push(objData.message);
          }
        });

        if (!chatData.target || !chatData.me) {
          console.log('Chat record not found for one side.');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 404,
              message: 'Chat record not found.',
              data: objData,
            }));
          }
          return null;
        }

        return query('UPDATE `msg` SET message = ? WHERE `UserToUser` = ?;', [JSON.stringify(chatData.target), targetUserToUser]);
      })
      .then(result => {
        if (!result || result.affectedRows !== 1) {
          return null;
        }

        return query('UPDATE `msg` SET message = ? WHERE `UserToUser` = ?;', [JSON.stringify(chatData.me), objData.UserToUser]);
      })
      .then(result => {
        if (!result || result.affectedRows !== 1) {
          return;
        }

        let data = { ...objData };
        if (objData.message.text.type === 'emoji') {
          data.message = {
            ...data.message,
            text: {
              ...data.message.text,
              url: 'images/emoji/' + data.message.text.url
            }
          };
        }

        if (['emoji', 'file', 'text'].includes(objData.message.text.type)) {
          wss.clients.forEach(function each(client) {
            if (
              client.readyState === WebSocket.OPEN &&
              (String(client.account) === String(objData.account) || String(client.account) === String(objData.target))
            ) {
              client.send(JSON.stringify({
                type: 200,
                data,
              }));
            }
          });
        }
      })
      .catch(err => {
        console.log('WebSocket message handling failed:', err);
      });
  });
});

module.exports = app;
