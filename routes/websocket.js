var express = require('express');//创建路由
var fs = require("fs");  // 引入fs模块
var query = require("../util/dbHelper.js");

var router = express.Router();
/* 优化聊天记录 */
function msg(data){
    //JSON.stringify()字符串转json对象
    //JSON.parse()json对象转字符串
    //JSON.parse(data[0].message)
    if(data.length){ // 如果最少有一条消息
        let arr = [];
        for(let i = 0;i<data.length;i++){
            data[i].message = JSON.parse(data[i].message);
            arr[i] = {
                ...data[i].message,
            };
            arr[i].url = arr[i].avatar;
            arr[i].avatar = undefined;
            let array = [];
            let idx = 0; // 初次加载获取信息数量
            for(let j=(arr[i].historyMessage.length-1);j<arr[i].historyMessage.length;j--){
                if(idx == 20){
                    break;
                }
                if(j < 0){
                    break;
                }
                idx++;
                if(arr[i].historyMessage[j].text.type == 'emoji'){ // 表情包
                    arr[i].historyMessage[j].text.url = 'images/emoji/'+arr[i].historyMessage[j].text.url;
                }else if(arr[i].historyMessage[j].text.type == 'file'){ // 文件
                    let suffix = arr[i].historyMessage[j].text.url.split('.'); // 文件后缀格式
                    arr[i].historyMessage[j].text.suffix = suffix[1];
                }
                array.unshift(arr[i].historyMessage[j]);
            }
            arr[i].historyMessage = array // array数量20个从后往前   
        }
        return arr;       
    }else{
        console.log([]);
        return [];
    }
};
function addMsg(data,length,target){
    let obj = {};
    if(data.length){ // 如果最少有一条消息
        for(let i = 0;i<data.length;i++){
            if(JSON.parse(data[i].message).id != target){ // 不是目标账号
                continue;
            }else{
                data[i].message = JSON.parse(data[i].message);
                obj = {
                    id:data[i].message.id,
                    title:data[i].message.title,
                    historyMessage:data[i].message.historyMessage,
                };
                console.log(obj.historyMessage.length,length);
                let start = obj.historyMessage.length-(length+20);
                start = start < 0 ? 0 : start;
                let end = obj.historyMessage.length-(length-1);
                console.log(start,end);
                obj.historyMessage =  obj.historyMessage.slice(start,end); // 截取不到就是空数组
                for(let j=0;j<obj.historyMessage.length;j++){
                    if(obj.historyMessage[j].text.type == 'emoji'){ // 表情包
                        obj.historyMessage[j].text.url = 'images/emoji/'+obj.historyMessage[j].text.url;
                    }else if(obj.historyMessage[j].text.type == 'file'){ // 文件
                        let suffix = obj.historyMessage[j].text.url.split('.'); // 文件后缀格式
                        obj.historyMessage[j].text.suffix = suffix[1];
                    }
                }
                break;
            }
        }
        return {
            status:200,
            result:obj
        }     
    }else{
        return {
            status:404,
            result:obj,
        };
    }
};
// get用req.query post用req.body
router.get("/init",function(req,res,next){
    let account = req.query.account;
    query("SELECT * FROM `login` LEFT JOIN `msg` ON msg.account = login.account WHERE msg.account = ?;",[account])
        .then(results => {
            let data = msg(results);
            res.send(data); // 返回每个用户，并且只有最后一条消息
        })
});
router.get("/getMoreMessage",function(req,res,next){
    let account = req.query.account;
    let length =  req.query.length;
    let target = req.query.target;
    length = parseInt(length);
    console.log(req.query);
    query("SELECT * FROM `login` LEFT JOIN `msg` ON msg.account = login.account WHERE msg.account = ?;",[account])
        .then(results => {
            let data = addMsg(results,length,target);
            res.send(data); // 返回每个用户，并且只有最后一条消息
        })
});

module.exports = router;
