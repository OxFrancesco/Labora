import {createElement} from 'react';
import {render} from '@gpuix/react';
import {Schema} from 'effect';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {App} from '../src/desktop/app';
import {createDesktopStore} from '../src/desktop/store';
import {BubbleAction} from '../src/desktop/bubble-contracts';

const store=await createDesktopStore();

process.once('exit',()=>store.flush());

render(createElement(App, {store, launchBubble:(receive)=>{
 const executable=process.env.LABORA_BUBBLE_EXECUTABLE;
 const child=Bun.spawn(executable ? [executable,'--bubble'] : [process.execPath,resolve('src/desktop/main.tsx'),'--bubble'],{stdin:'pipe',stdout:'pipe',stderr:'inherit',ipc:input=>receive(Schema.decodeUnknownSync(BubbleAction)(input))});

 const socket=createServer(client=>{
  client.on('data',chunk=>child.stdin.write(chunk));
  void (async()=>{for await(const chunk of child.stdout) client.write(chunk);})();
 });

 socket.listen(process.env.LABORA_BUBBLE_TEST_SOCKET);
 void child.exited.then(()=>socket.close());

 return child;
} }),{title:'Labora verification',width:1224,height:768,minWidth:800,minHeight:540,titlebarTransparent:true,windowBackground:'opaque'});
