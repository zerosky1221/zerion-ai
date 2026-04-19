# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "openai-agents>=0.0.17",
#   "httpx>=0.27.0",
# ]
# ///

import asyncio
import base64
import os
from urllib.parse import quote

import httpx
from agents import Agent, Runner, function_tool

ZERION_API_KEY = os.environ["ZERION_API_KEY"]
API_BASE = os.environ.get("ZERION_API_BASE", "https://api.zerion.io/v1")


def _auth_header() -> str:
    token = base64.b64encode(f"{ZERION_API_KEY}:".encode()).decode()
    return f"Basic {token}"


async def _get(path: str) -> dict:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(
            f"{API_BASE}{path}",
            headers={"Accept": "application/json", "Authorization": _auth_header()},
        )
        response.raise_for_status()
        return response.json()


@function_tool
async def wallet_portfolio(address: str) -> dict:
    return await _get(f"/wallets/{quote(address, safe='')}/portfolio")


@function_tool
async def wallet_positions(address: str, position_filter: str = "no_filter") -> dict:
    return await _get(f"/wallets/{quote(address, safe='')}/positions/?filter[positions]={quote(position_filter, safe='')}")


@function_tool
async def wallet_transactions(address: str) -> dict:
    return await _get(f"/wallets/{quote(address, safe='')}/transactions/?page[size]=10")


@function_tool
async def wallet_pnl(address: str) -> dict:
    return await _get(f"/wallets/{quote(address, safe='')}/pnl")


async def main() -> None:
    agent = Agent(
        name="Zerion Wallet Analyst",
        instructions=(
            "You are a read-only wallet analyst. "
            "Use the provided Zerion tools to analyze a wallet and summarize: "
            "portfolio overview, top positions, DeFi exposure, recent transactions, and PnL. "
            "If a tool fails, say exactly which part is missing."
        ),
        tools=[wallet_portfolio, wallet_positions, wallet_transactions, wallet_pnl],
    )

    result = await Runner.run(
        agent,
        "Analyze 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 and summarize the wallet.",
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
