// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVault} from "./IVault.sol";

/// @title PatchedVault
/// @notice The fix for VulnerableVault: checks-effects-interactions. The books are updated
/// before the external call, so a re-entrant withdrawAll() finds a zero balance and reverts.
contract PatchedVault is IVault {
    mapping(address => uint256) public balances;
    uint256 public totalDeposits;

    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        balances[msg.sender] += msg.value;
        totalDeposits += msg.value;
    }

    function withdrawAll() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "nothing to withdraw");
        balances[msg.sender] = 0;
        totalDeposits -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }
}
