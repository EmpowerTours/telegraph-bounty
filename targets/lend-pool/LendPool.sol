// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Demo bounty target written for this repo only. It contains a deliberate bug.
/// Never deploy it with real funds.
/// Ether money market with GOV as collateral. GOV balances live in this contract, and the
/// contract also runs the GOV/ETH exchange where GOV is bought and sold.
contract LendPool {
    mapping(address => uint) public govOf;
    uint public reserveEth;
    uint public reserveGov;

    mapping(address => uint) public supplied;
    mapping(address => uint) public collateral;
    mapping(address => uint) public debt;
    uint public totalSupplied;
    uint public totalCollateral;
    uint public totalDebt;

    constructor() {
        govOf[msg.sender] = 1_000_000 ether;
    }

    function addLiquidity(uint amount) external payable {
        govOf[msg.sender] -= amount;
        reserveGov += amount;
        reserveEth += msg.value;
    }

    function buyGov() external payable {
        uint out = (msg.value * 997 * reserveGov) / (reserveEth * 1000 + msg.value * 997);
        reserveEth += msg.value;
        reserveGov -= out;
        govOf[msg.sender] += out;
    }

    function sellGov(uint amount) external {
        uint out = (amount * 997 * reserveEth) / (reserveGov * 1000 + amount * 997);
        govOf[msg.sender] -= amount;
        reserveGov += amount;
        reserveEth -= out;
        _send(msg.sender, out);
    }

    function govPrice() public view returns (uint) {
        return (reserveEth * 1e18) / reserveGov;
    }

    function maxBorrow(address user) public view returns (uint) {
        return (collateral[user] * govPrice() * 75) / 1e20;
    }

    function supply() external payable {
        supplied[msg.sender] += msg.value;
        totalSupplied += msg.value;
    }

    function withdraw(uint amount) external {
        supplied[msg.sender] -= amount;
        totalSupplied -= amount;
        require(totalDebt <= totalSupplied, "no liquidity");
        _send(msg.sender, amount);
    }

    function depositCollateral(uint amount) external {
        govOf[msg.sender] -= amount;
        collateral[msg.sender] += amount;
        totalCollateral += amount;
    }

    function withdrawCollateral(uint amount) external {
        collateral[msg.sender] -= amount;
        totalCollateral -= amount;
        govOf[msg.sender] += amount;
        require(debt[msg.sender] <= maxBorrow(msg.sender), "unhealthy");
    }

    function borrow(uint amount) external {
        debt[msg.sender] += amount;
        totalDebt += amount;
        require(totalDebt <= totalSupplied, "no liquidity");
        require(debt[msg.sender] <= maxBorrow(msg.sender), "unhealthy");
        _send(msg.sender, amount);
    }

    function repay() external payable {
        debt[msg.sender] -= msg.value;
        totalDebt -= msg.value;
    }

    function _send(address to, uint amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "send failed");
    }
}
