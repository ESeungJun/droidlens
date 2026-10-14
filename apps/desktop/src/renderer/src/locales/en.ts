// 영어 사전: 한국어 원문 → 영어. 화면 영역별 파일로 나눠 두고 여기서 합친다.
import { common } from './en/common';
import { core } from './en/core';
import { data } from './en/data';
import { inspect } from './en/inspect';

export const en: Record<string, string> = { ...common, ...core, ...inspect, ...data };
