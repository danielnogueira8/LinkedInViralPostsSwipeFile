export type ChatDeliveryAcknowledgement = {
  accept: () => void;
  reject: () => void;
};

export function createChatDeliveryAcknowledgement(
  onDelivery?: (accepted: boolean) => void,
): ChatDeliveryAcknowledgement {
  let settled = false;
  const settle = (accepted: boolean) => {
    if (settled) return;
    settled = true;
    onDelivery?.(accepted);
  };
  return {
    accept: () => settle(true),
    reject: () => settle(false),
  };
}
