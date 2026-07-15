import JSONStream from './JSONStream'
import { createAPIURL } from './url-helper'
import { apiStreamFetch } from './api-stream'

// 工具文件,非 React 组件:Vue 的 ref() 改为普通可变对象({value}),保持 .value 访问接口不变
export function fetchData(url: any, data: any = {}) {
    const isDone = { value: false };
    const fetchResult: { value: any[] } = { value: [] };
    const jsonStream = new JSONStream({async: false});
    apiStreamFetch(createAPIURL(url), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
        .then(response => {
            const reader = response.body!.getReader();
            return new ReadableStream({
                start(controller) {
                    function push() {
                        reader.read().then(({done, value}) => {
                            if (done) {
                                controller.close();
                                isDone.value = true;
                                return;
                            }
                            const decoder = new TextDecoder('utf-8');
                            const resonseStr = decoder.decode(value);
                            try {
                                const jsonObj = JSON.parse(resonseStr);
                                fetchResult.value.push(jsonObj);
                            } catch {
                                try {
                                    jsonStream.transform(resonseStr, (error: any, jsonObj: any) => {
                                        if (error) {
                                            console.error(error);
                                        } else {
                                            fetchResult.value.push(jsonObj);
                                        }
                                    });
                                } catch (e) {
                                    console.log(e);
                                }
                            }
                            controller.enqueue(value);
                            push();
                        });
                    }

                    push();
                }
            });
        })

    return {isDone, fetchResult};
}
