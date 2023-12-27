import pkg from '@bot-whatsapp/bot'
import BaileysProvider from '@bot-whatsapp/provider/baileys'
import JsonFileAdapter from '@bot-whatsapp/database/json'
import { oraPromise } from 'ora'
import dotenv from 'dotenv-safe'
import PQueue from 'p-queue'
import { processAudio } from './services/Huggingface.js';
import { isAudio, simulateTyping, simulateEndPause, formatText } from './utils/index.js'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import BingAI from './services/BingAI.js';
import ChatGPT from './services/ChatGPT.js';

dotenv.config()

const bingAI = new BingAI({
    userToken: process.env.BINGAI_TOKEN,
    debug: false
})


const { createBot, createProvider, createFlow, addKeyword, EVENTS } = pkg

const queue = new PQueue({ concurrency: 1 });

const flowBotImage = addKeyword(EVENTS.MEDIA).addAnswer('Solo permito texto')

const flowBotDoc = addKeyword(EVENTS.DOCUMENT).addAnswer('solo permito texto')

const flowBotAudio = addKeyword(EVENTS.VOICE_NOTE).addAction(async (ctx, { fallBack, flowDynamic, gotoFlow, provider }) => {
    gotoFlow(flowBotWelcome)
})

const flowBotLocation = addKeyword(EVENTS.LOCATION).addAnswer('No permito leer ubicaciones')

const flowBotWelcome = addKeyword(EVENTS.WELCOME).addAnswer('En que puedo ayudarte', { capture: true },
    async (ctx, { fallBack, flowDynamic, endFlow, gotoFlow, provider, state }) => {
        if (isAudio(ctx)) {
            // process audio
            await flowDynamic('Escuchando Audio');
            const buffer = await downloadMediaMessage(ctx, 'buffer')
            const response = await processAudio(buffer, ctx.key.id + '.ogg')
            if (response.success) {
                ctx.body = response.output.data[0]
            } else {
                await flowDynamic('Error al procesar audio intenta de nuevo');
                await fallBack()
                return
            }
        }

        // simulate typing
        await simulateTyping(ctx, provider)

        // restart conversation
        if (ctx.body.toLowerCase().trim().includes('reiniciar') || ctx.body.toLowerCase().trim().includes('restart')) {
            state.update({
                name: ctx.pushName ?? ctx.from,
                conversationNumber: 0,
                finishedAnswer: true
            })


            await flowDynamic('REINICIANDO CONVERSACION')
            await simulateEndPause(ctx, provider)
            await gotoFlow(flowBotWelcome)

            return
        }

        if (!state?.getMyState()?.conversationBot) {

            let prompt = ctx.body.trim();

            try {
                const response = await queue.add(() => oraPromise(bingAI.sendMessage(prompt, {
                    jailbreakConversationId: true,
                    toneStyle: 'precise', // or creative, precise, fast default: balanced 
                    plugins: []
                })));

                await flowDynamic(formatText(response.response) ?? 'Error')
                const isImageResponse = await bingAI.detectImageInResponse(response)

                if (isImageResponse?.srcs?.length > 0) {
                    const srcs = isImageResponse.srcs.map(src => src.replace('w=270&h=270', 'w=1024&h=1024'))

                    srcs.forEach(async (src, index) => {
                        // if image not have w=1024&h=1024 continue
                        if (!src.includes('w=1024&h=1024')) return
                        await provider.vendor.sendMessage(ctx?.key?.remoteJid, {
                            image: {
                                url: src
                            },
                            caption: isImageResponse.urls[index]
                        })
                    })

                }

                state.update({
                    conversationBot: response,
                    conversationNumber: 1,
                    finishedAnswer: true
                })

            } catch (error) {
                state.update({ finishedAnswer: true });
                await flowDynamic('Error');
                await endFlow()
            }

            // stop typing
            await simulateEndPause(ctx, provider)
            await fallBack()
            return
        }

        new Promise((res) => setTimeout(res, 5000))

        if (state.getMyState()?.finishedAnswer === false) {
            flowDynamic('Un solo mensaje a la vez')
            await fallBack()
            return
        }

        if (state.getMyState()?.conversationBot?.conversationId) {

            let conversation = ctx.body.trim()

            state.update({
                finishedAnswer: false
            })

            try {
                let response = await queue.add(() => oraPromise(bingAI.sendMessage(conversation, {
                    jailbreakConversationId: state.getMyState()?.conversationBot.jailbreakConversationId,
                    parentMessageId: state.getMyState()?.conversationBot.messageId,
                    toneStyle: 'precise',
                    plugins: []
                })));

                await flowDynamic(formatText(response.response) ?? 'Error');
                const isImageResponse = await bingAI.detectImageInResponse(response)

                if (isImageResponse?.srcs?.length > 0) {
                    const srcs = isImageResponse.srcs.map(src => src.replace('w=270&h=270', 'w=1024&h=1024'))
                    srcs.forEach(async (src, index) => {
                        if (!src.includes('w=1024&h=1024')) return
                        await provider.vendor.sendMessage(ctx?.key?.remoteJid, {
                            image: {
                                url: src
                            },
                            caption: isImageResponse.urls[index]
                        })
                    })



                }

                state.update({
                    name: ctx.pushName ?? ctx.from,
                    conversationBot: response,
                    conversationNumber: state.getMyState()?.conversationNumber + 1,
                    finishedAnswer: true
                });

             
                if (state.getMyState()?.conversationNumber % 5 === 0 && state.getMyState()?.conversationNumber !== 0) {
                    // await flowDynamic('Restaurar Mensaje');
                }
            } catch (error) {
                console.error(error);
                state.update({ finishedAnswer: true });
                await flowDynamic('Error');
            }

            await simulateEndPause(ctx, provider);
            await fallBack()
            return


        }
    },
)

const main = async () => {
    const adapterDB = new JsonFileAdapter()
    const adapterFlow = createFlow([flowBotWelcome, flowBotImage, flowBotDoc, flowBotAudio, flowBotLocation])
    const adapterProvider = createProvider(BaileysProvider)

    createBot(
        {
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        },
        {
            globalState: {}
        }
    )

}

main()
