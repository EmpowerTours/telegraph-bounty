// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVault} from "./IVault.sol";

/// @title VulnerableVault
/// @notice DELIBERATELY VULNERABLE demo contract. Written for this repo only, as a bounty
/// target for local verification. Never deploy it.
/// @dev Bug: withdrawAll() pays before it updates the books, and reduces the books by the
/// caller's *current* stored balance. A re-entrant caller is paid on every nested call, the
/// innermost frame zeroes the balance, and the outer frames subtract 0, so
/// totalDeposits stops matching the ether actually held.
contract VulnerableVault is IVault {
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
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        totalDeposits -= balances[msg.sender];
        balances[msg.sender] = 0;
    }
}
