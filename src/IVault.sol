// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ABI shared by the vulnerable and patched demo vaults.
/// Stated bounty invariant (solvency): address(vault).balance >= vault.totalDeposits()
interface IVault {
    function deposit() external payable;
    function withdrawAll() external;
    function totalDeposits() external view returns (uint256);
    function balances(address account) external view returns (uint256);
}
