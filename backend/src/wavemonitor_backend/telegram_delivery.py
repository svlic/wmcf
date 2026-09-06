from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlmodel import Session

from wavemonitor_backend.api import require_id
from wavemonitor_backend.models import DeliveryStatus, TelegramDelivery
from wavemonitor_backend.notifier import (
    TelegramHttpFailure,
    TelegramSendResult,
    TelegramSendSuccess,
    sanitize_telegram_failure,
)

TELEGRAM_LOGGER = logging.getLogger("wavemonitor_backend.telegram")


def record_telegram_delivery(
    session: Session,
    *,
    message_kind: str,
    message_text: str,
    result: TelegramSendResult,
) -> TelegramDelivery:
    match result:
        case TelegramSendSuccess(message_id=message_id):
            delivery = TelegramDelivery(
                status=DeliveryStatus.SENT,
                message_kind=message_kind,
                message_text=message_text,
                telegram_message_id=message_id,
                delivered_at=datetime.now(UTC),
            )
        case TelegramHttpFailure() as failure:
            delivery = TelegramDelivery(
                status=DeliveryStatus.FAILED,
                message_kind=message_kind,
                message_text=message_text,
                safe_error=sanitize_telegram_failure(failure),
                delivered_at=datetime.now(UTC),
            )
    session.add(delivery)
    session.commit()
    session.refresh(delivery)
    TELEGRAM_LOGGER.info(
        "telegram_delivery_result status=%s message_kind=%s delivery_id=%s safe_error=%s",
        delivery.status.value,
        delivery.message_kind,
        require_id(delivery.id),
        delivery.safe_error or "none",
    )
    return delivery


