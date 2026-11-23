/** 다른 탭의 특정 항목으로 건너갈 때 넘기는 값. 받는 탭이 처음 그려질 때 한 번 꺼내 쓴다 */
let scenario: string | null = null;
let qaPlan: string | null = null;

export const requestScenario = (id: string) => {
  scenario = id;
};
export const takeScenario = () => {
  const id = scenario;
  scenario = null;
  return id;
};
export const requestQaPlan = (id: string) => {
  qaPlan = id;
};
export const takeQaPlan = () => {
  const id = qaPlan;
  qaPlan = null;
  return id;
};
