from collections.abc import Iterator
from contextlib import contextmanager
from os import getenv
from typing import Final

from sqlalchemy import Engine
from sqlalchemy.engine import Connection
from sqlmodel import Session, SQLModel, create_engine

DATABASE_URL_ENV: Final[str] = "DATABASE_URL"
LOCAL_SQLITE_DATABASE_URL: Final[str] = "sqlite:///./wavemonitor.sqlite3"


INSTRUMENT_COLUMNS: Final[str] = """
    id, name, enabled, alert_mode, supports, resistances, high_water, fixed_drawdown,
    near_support_threshold, risk_reward_threshold, created_at, updated_at,
    rule_cycle_started_at
"""
SOURCE_MAPPING_COLUMNS: Final[str] = """
    id, instrument_id, provider, market_type, symbol, enabled
"""


def database_url_from_env() -> str:
    return getenv(DATABASE_URL_ENV, LOCAL_SQLITE_DATABASE_URL)


def create_database_engine(database_url: str) -> Engine:
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    return create_engine(database_url, connect_args=connect_args)


def create_schema(engine: Engine) -> None:
    SQLModel.metadata.create_all(engine)
    if engine.dialect.name == "sqlite":
        with engine.begin() as connection:
            migrate_sqlite_schema(connection)


def migrate_sqlite_schema(connection: Connection) -> None:
    instrument_sql = _sqlite_table_sql(connection, "instrument")
    if instrument_sql is not None:
        if not _sqlite_column_exists(connection, "instrument", "alert_mode"):
            connection.exec_driver_sql(
                "ALTER TABLE instrument ADD COLUMN alert_mode VARCHAR NOT NULL DEFAULT 'static'"
            )
        if not _sqlite_column_exists(connection, "instrument", "high_water"):
            connection.exec_driver_sql(
                "ALTER TABLE instrument ADD COLUMN high_water NUMERIC(24, 10)"
            )
        if not _sqlite_column_exists(connection, "instrument", "fixed_drawdown"):
            connection.exec_driver_sql(
                "ALTER TABLE instrument ADD COLUMN fixed_drawdown NUMERIC(24, 10)"
            )
    instrument_nullable_columns = (
        "near_support_threshold",
        "risk_reward_threshold",
    )
    instrument_has_scalar_levels = instrument_sql is not None and (
        _sqlite_column_exists(connection, "instrument", "support")
        or _sqlite_column_exists(connection, "instrument", "resistance")
    )
    instrument_missing_level_arrays = instrument_sql is not None and (
        not _sqlite_column_exists(connection, "instrument", "supports")
        or not _sqlite_column_exists(connection, "instrument", "resistances")
    )
    instrument_needs_cycle = instrument_sql is not None and not (
        _sqlite_column_exists(connection, "instrument", "rule_cycle_started_at")
    )
    if instrument_needs_cycle:
        connection.exec_driver_sql(
            "ALTER TABLE instrument ADD COLUMN rule_cycle_started_at DATETIME"
        )
        connection.exec_driver_sql(
            "UPDATE instrument SET rule_cycle_started_at = "
            "COALESCE(updated_at, created_at, '0001-01-01 00:00:00')"
        )
    if (
        instrument_needs_cycle
        or instrument_has_scalar_levels
        or instrument_missing_level_arrays
        or any(
            _sqlite_column_is_not_null(connection, "instrument", column)
            for column in instrument_nullable_columns
        )
    ):
        _rebuild_sqlite_instrument_table(connection)
    source_mapping_sql = _sqlite_table_sql(connection, "sourcemapping")
    if source_mapping_sql is not None and (
        "uq_source_mapping_identity" in source_mapping_sql
        or "uq_source_mapping_per_instrument" not in source_mapping_sql
    ):
        _rebuild_sqlite_source_mapping_table(connection)
    if _sqlite_table_sql(connection, "lastrulestate") is not None:
        if not _sqlite_column_exists(connection, "lastrulestate", "support_breach_active"):
            connection.exec_driver_sql(
                "ALTER TABLE lastrulestate "
                "ADD COLUMN support_breach_active BOOLEAN NOT NULL DEFAULT 0"
            )
        if not _sqlite_column_exists(connection, "lastrulestate", "support_breach_last_alert_at"):
            connection.exec_driver_sql(
                "ALTER TABLE lastrulestate ADD COLUMN support_breach_last_alert_at DATETIME"
            )
    if _sqlite_table_sql(connection, "priceobservation") is not None:
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_priceobservation_observed_at "
            "ON priceobservation (observed_at)"
        )
    alert_event_sql = _sqlite_table_sql(connection, "alertevent")
    if alert_event_sql is not None and (
        not _sqlite_column_exists(connection, "alertevent", "rule_cycle_started_at")
        or "uq_alert_event_source_rule_cycle" not in alert_event_sql
    ):
        _rebuild_sqlite_alert_event_table(connection)


def _sqlite_table_sql(connection: Connection, table_name: str) -> str | None:
    row = connection.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return None if row is None else str(row[0])


def _sqlite_column_exists(connection: Connection, table_name: str, column_name: str) -> bool:
    rows = connection.exec_driver_sql(f"PRAGMA table_info({table_name})").fetchall()
    return any(str(row[1]) == column_name for row in rows)


def _sqlite_column_is_not_null(connection: Connection, table_name: str, column_name: str) -> bool:
    rows = connection.exec_driver_sql(f"PRAGMA table_info({table_name})").fetchall()
    return any(str(row[1]) == column_name and int(row[3]) == 1 for row in rows)


def _rebuild_sqlite_instrument_table(connection: Connection) -> None:
    has_support = _sqlite_column_exists(connection, "instrument", "support")
    has_resistance = _sqlite_column_exists(connection, "instrument", "resistance")
    has_supports = _sqlite_column_exists(connection, "instrument", "supports")
    has_resistances = _sqlite_column_exists(connection, "instrument", "resistances")
    supports_value = (
        "supports"
        if has_supports
        else "CASE WHEN support IS NULL THEN '[]' ELSE json_array(CAST(support AS TEXT)) END"
        if has_support
        else "'[]'"
    )
    resistances_value = (
        "resistances"
        if has_resistances
        else "CASE WHEN resistance IS NULL THEN '[]' ELSE json_array(CAST(resistance AS TEXT)) END"
        if has_resistance
        else "'[]'"
    )
    connection.exec_driver_sql("DROP TABLE IF EXISTS instrument_new")
    connection.exec_driver_sql(
        """
        CREATE TABLE instrument_new (
            id INTEGER NOT NULL,
            name VARCHAR(120) NOT NULL,
            enabled BOOLEAN NOT NULL,
            alert_mode VARCHAR NOT NULL DEFAULT 'static',
            supports JSON NOT NULL,
            resistances JSON NOT NULL,
            high_water NUMERIC(24, 10),
            fixed_drawdown NUMERIC(24, 10),
            near_support_threshold NUMERIC(24, 10),
            risk_reward_threshold NUMERIC(24, 10),
            created_at DATETIME,
            updated_at DATETIME,
            rule_cycle_started_at DATETIME NOT NULL,
            PRIMARY KEY (id)
        )
        """
    )
    connection.exec_driver_sql(
        f"INSERT INTO instrument_new ({INSTRUMENT_COLUMNS}) "
        "SELECT id, name, enabled, alert_mode, "
        f"{supports_value}, {resistances_value}, high_water, fixed_drawdown, "
        "near_support_threshold, risk_reward_threshold, created_at, updated_at, "
        "rule_cycle_started_at FROM instrument"
    )
    connection.exec_driver_sql("DROP TABLE instrument")
    connection.exec_driver_sql("ALTER TABLE instrument_new RENAME TO instrument")
    connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_instrument_name ON instrument (name)")


def _rebuild_sqlite_source_mapping_table(connection: Connection) -> None:
    connection.exec_driver_sql("DROP TABLE IF EXISTS sourcemapping_new")
    connection.exec_driver_sql(
        """
        CREATE TABLE sourcemapping_new (
            id INTEGER NOT NULL,
            instrument_id INTEGER NOT NULL,
            provider VARCHAR(11) NOT NULL,
            market_type VARCHAR(13) NOT NULL,
            symbol VARCHAR(80) NOT NULL,
            enabled BOOLEAN NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_source_mapping_per_instrument UNIQUE (
                instrument_id, provider, market_type, symbol
            ),
            FOREIGN KEY(instrument_id) REFERENCES instrument (id)
        )
        """
    )
    connection.exec_driver_sql(
        f"INSERT INTO sourcemapping_new ({SOURCE_MAPPING_COLUMNS}) "
        f"SELECT {SOURCE_MAPPING_COLUMNS} FROM sourcemapping"
    )
    connection.exec_driver_sql("DROP TABLE sourcemapping")
    connection.exec_driver_sql("ALTER TABLE sourcemapping_new RENAME TO sourcemapping")
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_sourcemapping_instrument_id ON sourcemapping (instrument_id)"
    )
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_sourcemapping_market_type ON sourcemapping (market_type)"
    )
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_sourcemapping_provider ON sourcemapping (provider)"
    )
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_sourcemapping_symbol ON sourcemapping (symbol)"
    )


def _rebuild_sqlite_alert_event_table(connection: Connection) -> None:
    has_cycle = _sqlite_column_exists(connection, "alertevent", "rule_cycle_started_at")
    instrument_cycle = (
        "(SELECT rule_cycle_started_at FROM instrument "
        "WHERE instrument.id = alertevent.instrument_id)"
    )
    cycle_value = (
        "rule_cycle_started_at"
        if has_cycle
        else f"CASE WHEN triggered_at >= {instrument_cycle} "
        f"THEN {instrument_cycle} ELSE triggered_at END"
    )
    connection.exec_driver_sql("DROP TABLE IF EXISTS alertevent_new")
    connection.exec_driver_sql(
        """
        CREATE TABLE alertevent_new (
            id INTEGER NOT NULL PRIMARY KEY,
            instrument_id INTEGER NOT NULL,
            source_mapping_id INTEGER NOT NULL,
            alert_kind VARCHAR(19) NOT NULL,
            price NUMERIC(24, 10) NOT NULL,
            support NUMERIC(24, 10) NOT NULL,
            resistance NUMERIC(24, 10) NOT NULL,
            threshold NUMERIC(24, 10),
            message VARCHAR(1000) NOT NULL,
            triggered_at DATETIME NOT NULL,
            rule_cycle_started_at DATETIME NOT NULL,
            CONSTRAINT uq_alert_event_source_rule_cycle UNIQUE (
                instrument_id, source_mapping_id, alert_kind, rule_cycle_started_at
            ),
            FOREIGN KEY(instrument_id) REFERENCES instrument (id),
            FOREIGN KEY(source_mapping_id) REFERENCES sourcemapping (id)
        )
        """
    )
    connection.exec_driver_sql(
        "INSERT INTO alertevent_new ("
        "id, instrument_id, source_mapping_id, alert_kind, price, support, resistance, "
        "threshold, message, triggered_at, rule_cycle_started_at) "
        "SELECT id, instrument_id, source_mapping_id, alert_kind, price, support, resistance, "
        f"threshold, message, triggered_at, {cycle_value} FROM alertevent "
        "WHERE id IN (SELECT MIN(id) FROM alertevent GROUP BY "
        f"instrument_id, source_mapping_id, alert_kind, {cycle_value}) ORDER BY id"
    )
    connection.exec_driver_sql("DROP TABLE alertevent")
    connection.exec_driver_sql("ALTER TABLE alertevent_new RENAME TO alertevent")
    for column in ("instrument_id", "source_mapping_id", "alert_kind"):
        connection.exec_driver_sql(
            f"CREATE INDEX IF NOT EXISTS ix_alertevent_{column} ON alertevent ({column})"
        )


@contextmanager
def session_scope(engine: Engine) -> Iterator[Session]:
    with Session(engine) as session:
        yield session
